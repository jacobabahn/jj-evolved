import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FrameParser, helperSettings, read, resetHelpers, type HelperRequest } from "../../src/repository/jj-helper";
import { Repository } from "../../src/repository/repository";
import { fixture } from "../fixture";

const fakeHelper = resolve(import.meta.dir, "../fake-helper.ts");
const installed = (await Bun.$`jj --version`.text()).match(/\d+\.\d+\.\d+/)![0];

let dir = "";
let logPath = "";
const saved = { ...process.env };

async function writeWrapper(path: string) {
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${fakeHelper}" "$@"\n`);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  resetHelpers();
  helperSettings.idleMs = 60_000;
  dir = await mkdtemp(join(tmpdir(), "jj-evolved-helper-"));
  logPath = join(dir, "log");
  await writeFile(logPath, "");
  await writeWrapper(join(dir, "helper"));
  Object.assign(process.env, { JJ_EVOLVED_HELPER: join(dir, "helper"), FAKE_HELPER_LOG: logPath, FAKE_HELPER_VERSION: installed });
  delete process.env.FAKE_HELPER_START;
});

afterEach(async () => {
  resetHelpers();
  helperSettings.idleMs = 60_000;
  for (const key of ["JJ_EVOLVED_HELPER", "FAKE_HELPER_LOG", "FAKE_HELPER_VERSION", "FAKE_HELPER_START"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  await rm(dir, { recursive: true, force: true });
});

const log = (revset: string, limit: number | undefined = 10): HelperRequest => ({ kind: "log", revset, template: "t", graph: false, ...(limit === undefined ? {} : { limit }) });
const unlimited = (revset: string): HelperRequest => ({ kind: "log", revset, template: "t", graph: false });
const noCli = async (): Promise<string> => { throw new Error("The CLI should not have run."); };
function cli(text = "cli") {
  const fallback = async () => { ++fallback.calls; return text; };
  fallback.calls = 0;
  return fallback;
}
async function events() {
  return (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { started?: number; pid?: number; request?: { id: number; revset?: string; kind: string; limit?: number; op?: string; template?: string; graph?: boolean; commitId?: string; paths?: string[] }; done?: number; args?: string[]; interactive?: string; eof?: number });
}
const pids = async () => (await events()).flatMap(event => event.started === undefined ? [] : [event.started]);
const requests = async () => (await events()).flatMap(event => event.request ? [event.request] : []);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 500 && !await condition(); attempt++) await Bun.sleep(10);
  expect(await condition()).toBe(true);
}

test("the frame parser copes with every chunk boundary, and with several frames in one chunk", () => {
  const encoder = new TextEncoder();
  const wire = encoder.encode(`{"id":1,"ok":true,"len":7}\nnaïve\n{"id":2,"ok":true,"len":0}\n{"id":3,"ok":false,"error":"x","len":0}\n`);
  const parsed = (chunks: Uint8Array[]) => {
    const parser = new FrameParser();
    return chunks.flatMap(chunk => [...parser.push(chunk)]).map(({ header, payload }) => [header.id, new TextDecoder().decode(payload)]);
  };
  const expected = [[1, "naïve\n"], [2, ""], [3, ""]];
  expect(parsed([wire])).toEqual(expected);
  for (let cut = 0; cut <= wire.length; cut++) expect(parsed([wire.subarray(0, cut), wire.subarray(cut)])).toEqual(expected);
  expect(parsed([...wire].map(byte => new Uint8Array([byte])))).toEqual(expected);
  for (const bad of ["nope\n", "[]\n", "null\n", '{"id":1}\n', '{"len":-1}\n', '{"len":1.5}\n']) {
    expect(() => [...new FrameParser().push(encoder.encode(bad))]).toThrow();
  }
  expect(() => [...new FrameParser().push(new Uint8Array(1 << 21).fill(120))]).toThrow("Oversized");
});

test("answers from the helper with the launch arguments and environment of the protocol", async () => {
  expect(await read(dir, log("echo:hello"), noCli)).toBe("hello");
  expect(await read(dir, log("echo:"), noCli)).toBe("");
  expect(await read(dir, { kind: "opId" }, noCli)).toBe("opId");
  const [started] = await events();
  expect(started?.args).toEqual(["--repository", dir, "--ignore-working-copy", "--at-op=@", "--no-pager", "--color=never", "--config", "ui.log-word-wrap=false", "serve"]);
  expect(started?.interactive).toBe("0");
  expect(await pids()).toHaveLength(1);
});

test("a split header, a split ready line and a character split across chunks all read correctly", async () => {
  process.env.FAKE_HELPER_START = "split";
  expect(await read(dir, log("split:héllo wörld ✓"), noCli)).toBe("héllo wörld ✓");
});

test("a large payload arrives whole", async () => {
  const size = 32 * 1024 * 1024;
  const text = await read(dir, log(`big:${size}`), noCli);
  expect(text.length).toBe(size);
  expect(text.startsWith("xxx") && text.endsWith("xxx")).toBe(true);
});

test("ok:false runs the CLI and keeps the process", async () => {
  const fallback = cli();
  expect(await read(dir, log("reject"), fallback)).toBe("cli");
  expect(fallback.calls).toBe(1);
  expect(await read(dir, log("echo:next"), noCli)).toBe("next");
  expect(await pids()).toHaveLength(1);
});

for (const [name, revset] of [["a crash", "crash"], ["a crash mid-payload", "crash-mid"], ["a clean exit nobody asked for", "exit-zero"],
  ["a malformed header", "garbage"], ["a negative length", "negative"], ["an endless header", "no-newline"], ["the wrong response ID", "wrong-id"]] as const) {
  test(`${name} runs the CLI, and the next read gets a fresh process`, async () => {
    const fallback = cli();
    expect(await read(dir, log(revset), fallback)).toBe("cli");
    expect(fallback.calls).toBe(1);
    expect(await read(dir, log("echo:next"), noCli)).toBe("next");
    const [first, second] = await pids();
    expect(second).toBeDefined();
    await until(() => !alive(first!));
  });
}

test("a helper that dies while idle counts as a crash and is replaced on the next read", async () => {
  expect(await read(dir, log("after-reply:one"), noCli)).toBe("one");
  await until(async () => !alive((await pids())[0]!));
  await Bun.sleep(20);
  expect(await read(dir, log("echo:two"), noCli)).toBe("two");
  expect(await pids()).toHaveLength(2);
});

test("exit 75 retries once through a new helper, without counting as a crash", async () => {
  expect(await read(dir, log("exit75-once:fresh"), noCli)).toBe("fresh");
  expect(await pids()).toHaveLength(2);
  expect(await read(dir, log("exit75-mid:whole"), noCli)).toBe("whole");
  expect(await pids()).toHaveLength(3);
  for (const text of ["a", "b", "c"]) expect(await read(dir, log(`exit75-once:${text}`), noCli)).toBe(text);
  expect(await pids()).toHaveLength(6);
});

test("a second exit 75 runs the CLI, and the helper stays in use", async () => {
  const fallback = cli();
  expect(await read(dir, log("exit75"), fallback)).toBe("cli");
  expect(fallback.calls).toBe(1);
  expect((await requests()).map(request => request.revset)).toEqual(["exit75", "exit75"]);
  expect(await read(dir, log("echo:next"), noCli)).toBe("next");
});

for (const start of ["wrong-version", "wrong-protocol"]) {
  test(`${start} disables the helper for the whole session`, async () => {
    process.env.FAKE_HELPER_START = start;
    const other = await mkdtemp(join(tmpdir(), "jj-evolved-helper-"));
    try {
      const fallback = cli();
      const results = await Promise.all([read(dir, log("echo:first"), fallback), read(dir, log("echo:second"), fallback)]);
      expect(results).toEqual(["cli", "cli"]);
      expect(await read(other, log("echo:other"), fallback)).toBe("cli");
      expect(fallback.calls).toBe(3);
      expect(await pids()).toHaveLength(1);
      expect(await requests()).toEqual([]);
    } finally { await rm(other, { recursive: true, force: true }); }
  });
}

for (const start of ["not-ready", "crash", "garbage"]) {
  test(`a helper that fails to start (${start}) runs the CLI, and counts towards the crash limit`, async () => {
    process.env.FAKE_HELPER_START = start;
    const fallback = cli();
    for (let attempt = 0; attempt < 5; attempt++) expect(await read(dir, log("echo:x"), fallback)).toBe("cli");
    expect(fallback.calls).toBe(5);
    expect(await pids()).toHaveLength(3);
  });
}

test("a helper that never becomes ready runs the CLI when the read's time is up", async () => {
  process.env.FAKE_HELPER_START = "hang";
  const fallback = cli();
  expect(await read(dir, log("echo:x"), fallback, { timeoutMs: 200 })).toBe("cli");
  await until(async () => !alive((await pids())[0]!));
});

test("a timeout kills the lane and throws run()'s message without running the CLI", async () => {
  await read(dir, log("echo:warm"), noCli);
  await expect(read(dir, log("hang"), noCli, { timeoutMs: 100 })).rejects.toThrow("jj command exceeded 0.1 seconds and was stopped.");
  await until(async () => !alive((await pids())[0]!));
  await expect(read(dir, log("hang"), noCli, { timeoutMs: 60 })).rejects.toThrow("jj command exceeded 0.06 seconds and was stopped.");
  expect(await read(dir, log("echo:next"), noCli)).toBe("next");
});

test("cancellation throws CancelledError, kills only what started, and leaves the queue running", async () => {
  await read(dir, log("echo:warm"), noCli);
  const already = new AbortController();
  already.abort();
  await expect(read(dir, log("echo:x"), noCli, { signal: already.signal })).rejects.toMatchObject({ name: "CancelledError", started: false });

  const running = new AbortController(), queued = new AbortController();
  const inFlight = read(dir, log("hang"), noCli, { signal: running.signal });
  const withdrawn = read(dir, log("echo:withdrawn"), noCli, { signal: queued.signal });
  const survivor = read(dir, log("echo:survivor"), noCli);
  await until(async () => (await requests()).some(request => request.revset === "hang"));
  queued.abort();
  await expect(withdrawn).rejects.toMatchObject({ name: "CancelledError", started: false });
  running.abort();
  await expect(inFlight).rejects.toMatchObject({ name: "CancelledError", started: true });
  expect(await survivor).toBe("survivor");
  await until(async () => !alive((await pids())[0]!));
  expect((await requests()).map(request => request.revset)).toEqual(["echo:warm", "hang", "echo:survivor"]);
});

test("cancelling a read that is waiting for ready leaves the process to serve the next one", async () => {
  const controller = new AbortController();
  const cancelled = read(dir, log("echo:x"), noCli, { signal: controller.signal });
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "CancelledError", started: false });
  expect(await read(dir, log("echo:next"), noCli)).toBe("next");
  expect(await pids()).toHaveLength(1);
});

test("a lane is a FIFO with one request in flight", async () => {
  const finished: string[] = [];
  const track = (promise: Promise<string>) => promise.then(text => { finished.push(text); return text; });
  await Promise.all([track(read(dir, log("slow:60:a"), noCli)), track(read(dir, log("echo:b"), noCli)), track(read(dir, log("slow:20:c"), noCli)), track(read(dir, log("echo:d"), noCli))]);
  expect(finished).toEqual(["a", "b", "c", "d"]);
  const order = (await events()).filter(event => event.request || event.done !== undefined).map(event => event.request ? "start" : "done");
  expect(order).toEqual(["start", "done", "start", "done", "start", "done", "start", "done"]);
});

test("the clock starts when a request reaches the head of its queue", async () => {
  await read(dir, log("echo:warm"), noCli);
  const [slow, queued] = await Promise.all([read(dir, log("slow:300:slow"), noCli), read(dir, log("echo:queued"), noCli, { timeoutMs: 100 })]);
  expect([slow, queued]).toEqual(["slow", "queued"]);
});

test("requests queued behind a killed lane run on a fresh process", async () => {
  await read(dir, log("echo:warm"), noCli);
  const hung = read(dir, log("hang"), noCli, { timeoutMs: 100 });
  const queued = [read(dir, log("echo:one"), noCli), read(dir, log("echo:two"), noCli)];
  await expect(hung).rejects.toThrow("exceeded");
  expect(await Promise.all(queued)).toEqual(["one", "two"]);
  expect(await pids()).toHaveLength(2);
});

test("requests queued behind a crash run on a fresh process, and only the one in flight runs the CLI", async () => {
  const fallback = cli();
  const results = await Promise.all([read(dir, log("crash"), fallback), read(dir, log("echo:one"), noCli), read(dir, log("echo:two"), noCli)]);
  expect(results).toEqual(["cli", "one", "two"]);
  expect(fallback.calls).toBe(1);
});

test("the third crash ends the helper for that root only, and the queue goes to the CLI", async () => {
  const other = await mkdtemp(join(tmpdir(), "jj-evolved-helper-"));
  try {
    const fallback = cli();
    const results = await Promise.all(["crash", "crash", "crash", "echo:a", "echo:b"].map(revset => read(dir, log(revset), fallback)));
    expect(results).toEqual(["cli", "cli", "cli", "cli", "cli"]);
    expect(fallback.calls).toBe(5);
    expect(await pids()).toHaveLength(3);
    expect(await read(dir, log("echo:later"), fallback)).toBe("cli");
    expect(await pids()).toHaveLength(3);
    expect(await read(other, log("echo:other"), noCli)).toBe("other");
  } finally { await rm(other, { recursive: true, force: true }); }
});

test("crashes on both lanes count together, and the survivors' queue goes to the CLI", async () => {
  const fallback = cli();
  await read(dir, log("crash"), fallback);
  await read(dir, unlimited("crash"), fallback, { bulk: true });
  const slow = read(dir, unlimited("hang"), fallback, { bulk: true });
  await until(async () => (await requests()).some(request => request.revset === "hang"));
  await read(dir, log("crash"), fallback);
  expect(await slow).toBe("cli");
  expect(fallback.calls).toBe(4);
});

test("an unlimited log runs on its own lazily spawned process and does not block bounded reads", async () => {
  expect(await read(dir, log("echo:fast"), noCli)).toBe("fast");
  expect(await pids()).toHaveLength(1);
  const search = read(dir, unlimited("slow:300:search"), noCli, { bulk: true });
  await until(async () => (await pids()).length === 2 && (await requests()).length === 2);
  let searching = true;
  void search.then(() => { searching = false; });
  expect(await read(dir, log("echo:selection"), noCli)).toBe("selection");
  expect(searching).toBe(true);
  expect(await search).toBe("search");
  const [fast, bulk] = await pids();
  const owners = (await events()).filter(event => event.request).map(event => event.pid);
  expect(owners).toEqual([fast, bulk, fast]);
  // Unlimited alone is not bulk: a small lookup with no limit stays on the fast lane.
  await read(dir, unlimited("echo:lookup"), noCli);
  expect((await events()).filter(event => event.request).at(-1)?.pid).toBe(fast);
});

test("a missing binary, and off, leave reads on the CLI silently", async () => {
  for (const value of [join(dir, "missing"), "off"]) {
    process.env.JJ_EVOLVED_HELPER = value;
    const fallback = cli();
    expect(await read(dir, log("echo:x"), fallback)).toBe("cli");
    expect(fallback.calls).toBe(1);
  }
  expect(await pids()).toEqual([]);
});

test("a binary that cannot be spawned falls back and stops being tried", async () => {
  const path = join(dir, "not-executable");
  await writeFile(path, "");
  process.env.JJ_EVOLVED_HELPER = path;
  const fallback = cli();
  for (let attempt = 0; attempt < 4; attempt++) expect(await read(dir, log("echo:x"), fallback)).toBe("cli");
  expect(fallback.calls).toBe(4);
});

test("an idle lane is reaped, without counting as a crash, and the next read starts another", async () => {
  helperSettings.idleMs = 30;
  for (let round = 1; round <= 4; round++) {
    expect(await read(dir, log("echo:x"), noCli)).toBe("x");
    const pid = (await pids()).at(-1)!;
    await until(() => !alive(pid));
    expect(await pids()).toHaveLength(round);
  }
});

test("work resets the idle clock", async () => {
  helperSettings.idleMs = 200;
  for (let round = 0; round < 4; round++) { await read(dir, log("echo:x"), noCli); await Bun.sleep(80); }
  expect(await pids()).toHaveLength(1);
});

test("a helper neither ends a pending read early nor keeps the app's event loop open", async () => {
  const script = join(dir, "app.ts");
  await writeFile(script, `import { read } from ${JSON.stringify(resolve(import.meta.dir, "../../src/repository/jj-helper.ts"))};
process.stdout.write(await read(${JSON.stringify(dir)}, { kind: "log", revset: "slow:300:answered", template: "t", graph: false, limit: 1 }, async () => "cli"));\n`);
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit", env: process.env });
  expect(await new Response(proc.stdout).text()).toBe("answered");
  expect(await proc.exited).toBe(0);
  expect(Date.now() - started).toBeLessThan(10_000);
  await until(async () => (await events()).some(event => event.eof !== undefined));
});

test("jj --version runs once however many helpers start", async () => {
  const fakeBin = join(dir, "bin");
  await Bun.$`mkdir -p ${fakeBin}`.quiet();
  await writeFile(join(fakeBin, "jj"), `#!/bin/sh\necho spawned >> "${join(dir, "versions")}"\nexec "${Bun.which("jj")}" "$@"\n`);
  await chmod(join(fakeBin, "jj"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${fakeBin}:${path}`;
  const other = await mkdtemp(join(tmpdir(), "jj-evolved-helper-"));
  try {
    await Promise.all([read(dir, log("echo:a"), noCli), read(dir, unlimited("echo:b"), noCli, { bulk: true }), read(other, log("echo:c"), noCli)]);
    expect((await readFile(join(dir, "versions"), "utf8")).trim().split("\n")).toHaveLength(1);
  } finally { process.env.PATH = path; await rm(other, { recursive: true, force: true }); }
});

test("routes the read paths with the CLI's exact text, and never anything that snapshots", async () => {
  // Every request is refused, so the CLI answers each one and the fixture's results stay real.
  process.env.FAKE_HELPER_REFUSE = "1";
  const f = await fixture();
  try {
    const repo = await Repository.open(f.path);
    const snapshot = await repo.snapshot("all()", true, 2);
    expect(snapshot.hasMore).toBe(true);
    const initial = (await repo.navigationRevisions("description(substring:Initial)"))[0]!;
    expect(await repo.diff(initial, ["hello.txt", "a b*.txt"])).toContain("+hello from jj-evolved");
    expect(await repo.files(initial)).toEqual([{ path: "hello.txt", status: "added" }]);
    const operation = await repo.operationId();
    expect(operation).toMatch(/^[0-9a-f]+$/);
    expect((await repo.bookmarks()).map(bookmark => bookmark.name)).toContain("feature");
    await repo.rebaseScope(initial, operation);

    const routed = (await requests()).map(({ id: _, ...request }) => request);
    const template = (await requests())[0]!.template!;
    expect(template).toContain("::jj-evolved-description::");
    const revisionTemplate = routed[2]!.template;
    expect(routed).toEqual([
      { kind: "log", revset: "all()", template, limit: 2, graph: true },
      { kind: "log", revset: "all()", template: '"x"', limit: 3, graph: false },
      { kind: "log", revset: "description(substring:Initial)", template: revisionTemplate, graph: false, op: "@" },
      { kind: "diff", commitId: initial.commitId, paths: ['root-file:"hello.txt"', 'root-file:"a b*.txt"'] },
      { kind: "files", commitId: initial.commitId, template: "'[' ++ json(path) ++ ',' ++ json(status) ++ ']\n'" },
      { kind: "opId" },
      { kind: "bookmarks", template: routed[6]!.template },
      { kind: "log", revset: `${initial.commitId}::`, template: revisionTemplate, graph: false, op: operation },
    ]);
    expect(routed[6]!.template).toContain("tracking_ahead_count");

    await writeFile(logPath, "");
    await repo.snapshot("all()");
    await repo.status();
    await repo.snapshotOperationId();
    await repo.apply(await repo.prepare({ kind: "describe", revision: snapshot.revisions[0]!, description: "Changed" }));
    expect((await requests()).filter(request => request.kind === "log" && request.graph)).toEqual([]);
    expect(new Set((await requests()).map(request => request.kind)).has("diff")).toBe(false);
    expect((await repo.snapshot("@", false)).revisions[0]?.description).toBe("Changed\n");
  } finally { delete process.env.FAKE_HELPER_REFUSE; await f.cleanup(); }
});
