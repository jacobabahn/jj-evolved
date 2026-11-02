// @ts-nocheck
import { Session, buckets, threadCpu, W } from "./lib";
const s = new Session(`${W}/repos/jj`);
const t0 = Date.now(); let c0 = {main: 0};
await s.start();
console.log("pid", s.pid);
const ready = await s.waitScreen(x => x.includes("Ready"), 30000);
console.log("ready", ready && ready - t0);
const d = await s.settle(t0, {min: 3});
console.log(d, d.done - t0);
const c1 = threadCpu(s.pid);
console.log(c1);
console.log(JSON.stringify(buckets(s, t0, d.done, c0, c1), null, 0));
console.log(s.screen().split("\n").slice(0, 14).join("\n"));
const t1 = Date.now(), c2 = threadCpu(s.pid);
s.key("C-r");
const e = await s.settle(t1, {min: 3});
console.log(JSON.stringify(buckets(s, t1, e.done, c2, threadCpu(s.pid))));
await s.stop();
