// @ts-nocheck
import { Session, W } from "./lib";
const s = new Session(`${W}/repos/git`);
let t0 = Date.now(); await s.start(); await s.waitScreen(x => /Ready/.test(x)); await s.settle(t0, { min: 2 });
s.key("L"); await Bun.sleep(150); s.key("C-a"); s.key("C-k"); s.key("all()", true); await Bun.sleep(100);
t0 = Date.now(); s.key("Enter"); await s.settle(t0, { min: 2 });
const view = (tag: string) => { const l = s.screen().split("\n"); console.log(tag, "|", l[1]?.slice(0, 70), "|", l[2]?.slice(0, 80)); console.log("  rows:", l.slice(4, 9).map(x => x.slice(0, 46)).join(" / ")); console.log("  preview:", l[4]?.slice(62, 110), "::", l[7]?.slice(62, 110)); };
let loaded = 200, presses = 0;
for (const target of [4800, 5000, 5200, 6000, 7000, 8000, 9000, 10000]) {
  while (loaded < target) { const t = Date.now(); s.key("C-l"); const d = await s.settle(t, { min: 2, frameAfter: t, timeout: 30000 }); if (d.timedOut) console.log("press timed out at", loaded); loaded += 200; presses++; }
  s.read(); const before = s.events.filter(e => e.k === "start").length;
  const t = Date.now(); s.key("j"); await s.settle(t, { frameAfter: t, timeout: 3000, quiet: 200 }); s.read();
  const spawned = s.events.filter(e => e.k === "start").slice(before).map(e => e.args.slice(0, 40));
  console.log("loaded", target, "spawned after j:", spawned);
  if (target >= 9000 || target === 4800) view(`at ${target}`);
}
await s.stop();
