// @ts-nocheck
import { Session, W } from "./lib";
const s = new Session(`${W}/repos/lin-1m`);
const t0 = Date.now(); await s.start(); await s.waitScreen(x => /Ready/.test(x)); await s.settle(t0, { min: 2 });
s.key("r"); await Bun.sleep(600); const t = Date.now(); s.key("/"); await s.settle(t, { min: 2, timeout: 60000 });
s.key("C-e"); await Bun.sleep(600);
console.log(s.screen().split("\n").slice(0, 20).map(l => l.slice(0, 130)).join("\n"));
await s.stop();
