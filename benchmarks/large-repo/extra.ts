// @ts-nocheck
// Renderable-per-row cost past one page, driven through real Ctrl-L presses; and cold-cache startup.
import { Session, W, buckets, hwm, save, stats, threadCpu } from "./lib";
const s = new Session(`${W}/repos/git`);
let t0 = Date.now(); await s.start(); await s.waitScreen(x => /Ready/.test(x)); await s.settle(t0, { min: 2 });
s.key("L"); await Bun.sleep(150); s.key("C-a"); s.key("C-k"); s.key("all()", true); await Bun.sleep(100);
t0 = Date.now(); s.key("Enter"); await s.settle(t0, { min: 2 });
let loaded = 200;
for (const target of [1000, 2000, 5000, 10000, 20000]) {
  let press: any = null;
  while (loaded < target) {
    const c0 = threadCpu(s.pid), t = Date.now(); s.key("C-l");
    const d = await s.settle(t, { min: 2, frameAfter: t, timeout: 60000 }); s.read();
    press = buckets(s, t, d.done, c0, threadCpu(s.pid)); loaded += 200;
  }
  const steps: number[] = []; let stall = 0, ts = 0, render = 0;
  for (let i = 0; i < 11; i++) {
    const c0 = threadCpu(s.pid), t = Date.now(); s.key("j");
    const d = await s.settle(t, { min: 1, frameAfter: t, timeout: 20000 }); s.read();
    const b = buckets(s, t, d.done, c0, threadCpu(s.pid));
    if (i) { steps.push(b.wall); stall = Math.max(stall, b.maxStall); ts += b.tsMs / 10; render += b.renderMs / 10; }
    await Bun.sleep(150);
  }
  const reload = await (async () => { const c0 = threadCpu(s.pid), t = Date.now(); s.key("C-r"); const d = await s.settle(t, { min: 3, timeout: 60000 }); s.read(); return buckets(s, t, d.done, c0, threadCpu(s.pid)); })();
  const rec = { loaded, loadMore: { wall: press.wall, jj: press.jjUnion, ts: press.tsMs, render: press.renderMs, setSnap: press.setSnapshotMs, stall: press.maxStall }, step: stats(steps), stepTs: ts, stepRender: render, stall, reload: { wall: reload.wall, jj: reload.jjUnion, ts: reload.tsMs, render: reload.renderMs, setSnap: reload.setSnapshotMs, stall: reload.maxStall }, rss: hwm(s.pid) };
  save("rows.jsonl", rec); console.log(JSON.stringify(rec));
}
await s.stop();
for (const repo of ["jj", "rust", "linux"]) {
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    Bun.spawnSync(["python3", "-I", `${W}/scripts/evict.py`, `${W}/repos/${repo}`]);
    const c = new Session(`${W}/repos/${repo}`); const t = Date.now(); await c.start();
    const ready = await c.waitScreen(x => /Ready/.test(x), 120000); runs.push(ready! - t); await c.stop();
  }
  const st = stats(runs); save("cold.jsonl", { repo, ...st }); console.log("cold startup", repo, st.median, st.min, st.max);
}
