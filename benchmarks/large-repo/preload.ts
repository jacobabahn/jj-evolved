// @ts-nocheck
// Bench-only timing preload. Loaded with `bun --preload`; wraps Bun.spawn and OpenTUI/app prototypes from the outside.
// Writes one JSON object per line to $BENCH_TRACE. No product source is modified.
import { appendFileSync } from "node:fs";
const out = process.env.BENCH_TRACE!;
const APP = process.env.BENCH_APP!;
const heartbeat = process.env.BENCH_HEARTBEAT !== "0";
let buffer: string[] = [];
const emit = (e: object) => { buffer.push(JSON.stringify(e)); };
const flush = () => { if (buffer.length) { appendFileSync(out, buffer.join("\n") + "\n"); buffer = []; } };
process.on("exit", flush);

// A helper lives for the whole session, so it isn't a process span. Each request is a span instead: start when the line
// is written, end when its frame arrives. Chunks are tagged with their process because both lanes reuse request ids.
const helperOpen = new Map<string, number>();
function trackHelper(proc: any) {
  const pid = proc.pid, { stdin, stdout } = proc;
  // FileSink.write is read-only, so the client gets a stand-in for stdin rather than a patched one.
  const sink = {
    write(line: string) {
      const req = JSON.parse(line), id = ++spawnId;
      helperOpen.set(`${pid}:${req.id}`, id);
      emit({ k: "start", id, t: Date.now(), syncMs: 0, args: `helper:${req.kind}${req.limit === undefined ? "" : ` ${req.limit}`}${req.revset ? ` ${req.revset}` : ""}`.slice(0, 300) });
      return stdin.write(line);
    },
    flush: () => stdin.flush(),
    unref: () => stdin.unref(),
  };
  const getReader = stdout.getReader.bind(stdout);
  stdout.getReader = () => {
    const reader = getReader(), read = reader.read.bind(reader);
    reader.read = async () => { const r = await read(); if (r.value) r.value.__helperPid = pid; return r; };
    return reader;
  };
  return new Proxy(proc, { get(target, key) {
    if (key === "stdin") return sink;
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
const spawn = Bun.spawn;
let spawnId = 0;
(Bun as any).spawn = function (cmd: any, opts: any) {
  const t0 = Date.now(), id = ++spawnId;
  const p0 = performance.now();
  const proc = spawn(cmd, opts);
  if (Array.isArray(cmd) && String(cmd[0]).endsWith("jj-evolved-helper")) return trackHelper(proc);
  const syncMs = performance.now() - p0;
  const args = Array.isArray(cmd) ? cmd.slice(1).filter((a: string) => a !== "--no-pager" && a !== "--color=never").join(" ").slice(0, 300) : "";
  emit({ k: "start", id, t: t0, syncMs, args });
  proc.exited.then((code: number) => {
    const u = proc.resourceUsage?.();
    emit({ k: "exit", id, t: Date.now(), code, user: u ? Number(u.cpuTime.user) / 1000 : null, sys: u ? Number(u.cpuTime.system) / 1000 : null, rss: u?.maxRSS ?? null });
    flush();
  });
  return proc;
};

const { CliRenderer, RootRenderable } = await import(`${APP}/node_modules/@opentui/core/index.bun.js`);
const timed = (proto: any, name: string, kind: string) => {
  const original = proto[name];
  proto[name] = function (...args: unknown[]) {
    const t = Date.now(), s = performance.now();
    try { return original.apply(this, args); }
    finally { emit({ k: kind, t, ms: performance.now() - s }); }
  };
};
timed(RootRenderable.prototype, "render", "root");   // JS: lifecycle passes, Yoga layout, per-renderable draw calls
timed(CliRenderer.prototype, "renderNative", "native"); // native diff + terminal write (no render thread on Linux)

const { FrameParser } = await import(`${APP}/src/repository/jj-helper.ts`);
const framePush = FrameParser.prototype.push;
FrameParser.prototype.push = function* (chunk: any) {
  for (const frame of framePush.call(this, chunk)) {
    const key = `${chunk.__helperPid}:${frame.header.id}`, id = helperOpen.get(key);
    if (id !== undefined) { helperOpen.delete(key); emit({ k: "exit", id, t: Date.now(), code: frame.header.ok ? 0 : 1, user: 0, sys: 0, rss: 0 }); flush(); }
    yield frame;
  }
};

const { RevisionLog } = await import(`${APP}/src/revisions/revision-log.ts`);
timed(RevisionLog.prototype, "setSnapshot", "setSnapshot");
timed(RevisionLog.prototype, "setSelectedIndex", "setSelected");
const { ChangePreview } = await import(`${APP}/src/preview/change-preview.ts`);
const descriptor = Object.getOwnPropertyDescriptor(ChangePreview.prototype, "content")!;
Object.defineProperty(ChangePreview.prototype, "content", { ...descriptor, set(value: string) {
  const t = Date.now(), s = performance.now();
  descriptor.set!.call(this, value);
  emit({ k: "previewContent", t, ms: performance.now() - s, chars: value.length, blocks: this.getChildren().length });
} });
const { Repository } = await import(`${APP}/src/repository/repository.ts`);
for (const name of ["snapshot", "bookmarks", "navigationRevisions", "rebaseScope", "diff", "prepare"]) {
  const original = Repository.prototype[name];
  Repository.prototype[name] = async function (...args: unknown[]) {
    const t = Date.now();
    try { return await original.apply(this, args); }
    finally { emit({ k: "repo", name, t, end: Date.now() }); }
  };
}

if (heartbeat) {
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - last > 40) emit({ k: "stall", t: last, ms: now - last });
    last = now;
    emit({ k: "hb", t: now });
    flush();
  }, 20).unref();
} else setInterval(flush, 500).unref();
