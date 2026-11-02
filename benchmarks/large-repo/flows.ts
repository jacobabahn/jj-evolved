// @ts-nocheck
// Drives the real app in tmux through each flow and attributes time. Usage: flows.ts <repo> [flow,flow...]
import { Session, W, buckets, helperUsage, hwm, jj, save, sh, stats, threadCpu } from "./lib";
const [name, wanted] = process.argv.slice(2) as [string, string?];
const repo = `${W}/repos/${name}`;
const on = (flow: string) => !wanted || wanted.split(",").includes(flow);
const REPEAT = Number(process.env.REPEAT ?? 10);
const heavy = ["linux", "rust", "lin-1m"].includes(name);
const say = (flow: string, r: any) => console.log(`${name} ${flow} wall=${Math.round(r.wall)} jj=${Math.round(r.jjUnion)}(${r.jjCount}p cpu ${Math.round(r.jjCpu)}) ts=${Math.round(r.tsMs)} render=${Math.round(r.renderMs)} workers=${Math.round(r.workerCpu)} stall=${Math.round(r.maxStall)} f=${r.frames} rss=${r.hwm ? Math.round(r.hwm) : ""} hrss=${Math.round(r.helperHwm ?? 0)}${r.timedOut ? " TIMEOUT" : ""}${r.note ? " " + r.note : ""}`);
const record = (flow: string, i: number, r: any) => { save("flows.jsonl", { repo: name, flow, i, run: process.env.RUN ?? "1", ...r }); say(`${flow}#${i}`, r); };

async function open(view: "default" | "all", opts: ConstructorParameters<typeof Session>[1] = {}) {
  const s = new Session(repo, opts);
  const t0 = Date.now();
  await s.start();
  const ready = await s.waitScreen(x => /Ready/.test(x), 120_000);
  if (!ready) { console.log(s.screen()); throw new Error(`${name}: not ready`); }
  await s.settle(t0, { min: 2 });
  if (view === "all") {
    await act(s, () => { s.key("L"); }, { quiet: 120 });
    s.key("C-a"); s.key("C-k"); s.key("all()", true);
    await Bun.sleep(100);
    const t = Date.now(); s.key("Enter");
    await s.waitScreen(x => x.includes("revset: all()") && !x.includes("Loading revset"), 120_000);
    await s.settle(t, { min: 1 });
  }
  return { s, ready: ready - t0 };
}
async function act(s: Session, go: () => void, o: { min?: number; quiet?: number; timeout?: number; frame?: boolean } = {}) {
  const c0 = threadCpu(s.pid), t0 = Date.now();
  go();
  const d = await s.settle(t0, { min: o.min ?? 0, quiet: o.quiet ?? 300, timeout: o.timeout ?? 180_000, frameAfter: o.frame ? t0 : 0 });
  s.read();
  return { ...buckets(s, t0, d.done, c0, threadCpu(s.pid)), hwm: hwm(s.pid), ...helperUsage(s.pid), timedOut: d.timedOut };
}

// ---- startup
if (on("startup") || on("startup-all")) {
  for (const flow of ["startup"] as const) {
    const n = heavy ? 6 : REPEAT + 1;
    for (let i = 0; i < n; i++) {
      const s = new Session(repo);
      const t0 = Date.now();
      await s.start();
      const ready = await s.waitScreen(x => /Ready/.test(x), 120_000);
      const d = await s.settle(t0, { min: 2 });
      s.read();
      const cpu = threadCpu(s.pid);
      const r = { ...buckets(s, t0, ready ?? Date.now(), {}, cpu), hwm: hwm(s.pid), readyMs: ready ? ready - t0 : null, settleMs: d.done - t0, ...helperUsage(s.pid) };
      await s.stop();
      if (i) record(flow, i, r); // i=0 is the discarded warm-up
    }
  }
}

// ---- idle polling: heartbeat off so the sampler's own timer does not count as idle CPU
if (on("idle")) {
  const s = new Session(repo, { heartbeat: false });
  await s.start();
  await s.waitScreen(x => /Ready/.test(x), 120_000);
  await Bun.sleep(3000);
  s.read();
  const c0 = threadCpu(s.pid), t0 = Date.now();
  const seconds = Number(process.env.IDLE_SECONDS ?? 40);
  await Bun.sleep(seconds * 1000);
  s.read();
  const t1 = Date.now(), c1 = threadCpu(s.pid);
  const b = buckets(s, t0, t1, c0, c1);
  const per = b.procs.map(p => p.ms), cpus = b.procs.map(p => p.cpu);
  const r = { ...b, procs: undefined, polls: per.length, pollWall: stats(per.length ? per : [0]), pollCpu: stats(cpus.length ? cpus : [0]), bunCpuPerSec: (b.mainCpu + b.workerCpu) / seconds, jjCpuPerSec: b.jjCpu / seconds, hwm: hwm(s.pid) };
  save("flows.jsonl", { repo: name, flow: "idle", i: 0, ...r });
  console.log(`${name} idle polls=${r.polls} wall=${JSON.stringify(r.pollWall)} cpu=${JSON.stringify(r.pollCpu)} jjCpu/s=${r.jjCpuPerSec.toFixed(1)}ms bunCpu/s=${r.bunCpuPerSec.toFixed(1)}ms rss=${Math.round(r.hwm)}`);
  await s.stop();
}

// ---- reload, in both views
for (const view of ["default", "all"] as const) if (on(`reload-${view}`)) {
  const { s } = await open(view);
  for (let i = 0; i <= (heavy ? 6 : REPEAT); i++) {
    const r = await act(s, () => s.key("C-r"), { min: 3 });
    if (i) record(`reload-${view}`, i, r);
    await Bun.sleep(200);
  }
  await s.stop();
}

// ---- selection in the all() view: isolated steps, then a held key
if (on("select")) {
  const { s } = await open("all");
  for (let i = 0; i <= REPEAT; i++) {
    const r = await act(s, () => s.key("j"), { min: 1 });
    if (i) record("select-step", i, r);
    await Bun.sleep(250);
  }
  for (let i = 0; i < 3; i++) {
    const c0 = threadCpu(s.pid), t0 = Date.now();
    for (let k = 0; k < 45; k++) { s.key(i % 2 ? "k" : "j"); await Bun.sleep(30); }
    const lastKey = Date.now();
    const d = await s.settle(t0, {});
    s.read();
    const r = { ...buckets(s, t0, d.done, c0, threadCpu(s.pid)), catchUp: d.done - lastKey };
    record("select-held45", i + 1, r);
    await Bun.sleep(300);
  }
  await s.stop();
}

// ---- search: open, type, accept, in the given view
for (const view of ["default", "all"] as const) if (on(`search-${view}`)) {
  const query = process.env.QUERY ?? "fix";
  for (let i = 0; i < (heavy ? 3 : 5); i++) {
    const { s } = await open(view);
    const a = await act(s, () => s.key("/"), { min: view === "all" ? 2 : 0, timeout: 120_000, quiet: 150, frame: true });
    record(`search-${view}-open`, i, a);
    const c0 = threadCpu(s.pid), t0 = Date.now();
    let lastKey = t0;
    for (const ch of query) { lastKey = Date.now(); s.key(ch, true); await Bun.sleep(80); }
    const d = await s.settle(t0, { timeout: 120_000, frameAfter: lastKey });
    s.read();
    record(`search-${view}-type`, i, { ...buckets(s, t0, d.done, c0, threadCpu(s.pid)), hwm: hwm(s.pid), ...helperUsage(s.pid) });
    const e = await act(s, () => s.key("Enter"), { timeout: 120_000, frame: true });
    record(`search-${view}-accept`, i, e);
    await s.stop();
  }
}

// ---- the all() destination picker (src/app.ts:882)
if (on("picker")) {
  for (let i = 0; i < (heavy ? 3 : 5); i++) {
    const { s } = await open("default");
    await act(s, () => s.key("r"), { min: 1, quiet: 120 });
    const a = await act(s, () => s.key("/"), { min: 2, timeout: 170_000, quiet: 300 });
    record("picker-open", i, { ...a, note: a.procs.filter(p => p.code).map(p => `rc=${p.code}`).join(" ") });
    const c0 = threadCpu(s.pid), t0 = Date.now();
    let lastKey = t0;
    for (const ch of "fix") { lastKey = Date.now(); s.key(ch, true); await Bun.sleep(80); }
    const d = await s.settle(t0, { timeout: 170_000, frameAfter: lastKey });
    s.read();
    record("picker-type", i, { ...buckets(s, t0, d.done, c0, threadCpu(s.pid)), hwm: hwm(s.pid), ...helperUsage(s.pid), timedOut: d.timedOut });
    await s.stop();
  }
}
console.log("flows done", name);
