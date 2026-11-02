// @ts-nocheck
// Preload cost: time-to-Ready and post-load key latency with and without the preload.
import { Session, W, save, stats } from "./lib";
for (const preload of [false, true, false, true]) {
  const xs: number[] = [];
  for (let i = 0; i < 11; i++) {
    const s = new Session(`${W}/repos/lin-1k`, { preload });
    const t0 = Date.now(); await s.start();
    const r = await s.waitScreen(x => /Ready/.test(x), 20000);
    xs.push(r! - t0); s.tmux("kill-server"); await Bun.sleep(50);
  }
  const st = stats(xs.slice(1)); save("overhead.jsonl", { preload, ...st }); console.log(preload, st);
}
