// @ts-nocheck
import { Session, W, buckets, save, stats, threadCpu } from "./lib";
const s = new Session(`${W}/repos/git`);
let t0 = Date.now(); await s.start(); await s.waitScreen(x => /Ready/.test(x)); await s.settle(t0, { min: 2 });
s.key("L"); await Bun.sleep(150); s.key("C-a"); s.key("C-k"); s.key("all()", true); await Bun.sleep(100);
t0 = Date.now(); s.key("Enter"); await s.settle(t0, { min: 2 });
let loaded = 200;
for (const target of [200, 5000, 10000, 20000]) {
  while (loaded < target) { const t = Date.now(); s.key("C-l"); await s.settle(t, { min: 2, frameAfter: t, timeout: 60000 }); loaded += 200; }
  const rows: any[] = [];
  for (let i = 0; i < 16; i++) {
    const c0 = threadCpu(s.pid), t = Date.now(); s.key("j");
    const d = await s.settle(t, { frameAfter: t, timeout: 10000, quiet: 200 }); s.read();
    rows.push(buckets(s, t, d.done, c0, threadCpu(s.pid)));
    await Bun.sleep(120);
  }
  const r = rows.slice(1), med = (k: string) => stats(r.map(x => x[k])).median;
  const rec = { loaded, wall: stats(r.map(x => x.wall)), jj: med("jjUnion"), spawned: stats(r.map(x => x.jjCount)), ts: med("tsMs"), render: med("renderMs"), root: med("rootMs"), native: med("nativeMs"), stall: Math.max(...r.map(x => x.maxStall)) };
  save("rows.jsonl", { second: true, ...rec }); console.log(JSON.stringify(rec));
}
await s.stop();
