// @ts-nocheck
// CPU profiles of the real app: bun --cpu-prof-md. Quits with q so the profile is written.
import { Session, W, jj } from "./lib";
import { readFileSync } from "node:fs";
const [what] = process.argv.slice(2);
process.env.BENCH_BUNFLAGS = `--cpu-prof-md --cpu-prof-dir=${W}/results/prof-${what} --cpu-prof-name=${what}.md --cpu-prof-interval=2000`;
const profiled = async (repo: string, steps: (s: Session) => Promise<void>) => {
  const s = new Session(`${W}/repos/${repo}`);
  const t0 = Date.now(); await s.start(); await s.waitScreen(x => /Ready/.test(x)); await s.settle(t0, { min: 2 });
  await steps(s);
  s.key("q");
  for (let i = 0; i < 6000 && s.alive(); i++) await Bun.sleep(10);
  console.log("exited", !s.alive());
  await s.stop();
};
const filter = async (s: Session, revset: string) => { s.key("L"); await Bun.sleep(150); s.key("C-a"); s.key("C-k"); s.key(revset, true); await Bun.sleep(100); const t = Date.now(); s.key("Enter"); await s.settle(t, { min: 2, timeout: 120000 }); };
const id = (d: string) => jj(`${W}/repos/diffs`, "--ignore-working-copy", "log", "--no-graph", "-r", `description(exact:${JSON.stringify(d + "\n")})`, "-T", "commit_id").trim();
if (what === "noisy" || what === "lines100k") {
  const label = what === "noisy" ? "noisy400files" : "lines100000";
  await profiled("diffs", async s => { await filter(s, `${id(`small after ${label}`)} | ${id(`huge ${label}`)}`); const t = Date.now(); s.key("j"); await s.settle(t, { min: 1, timeout: 120000 }); });
}
if (what === "search") await profiled("rust", async s => { await filter(s, "all()"); const t = Date.now(); s.key("/"); await s.settle(t, { min: 2, timeout: 120000, frameAfter: t }); });
