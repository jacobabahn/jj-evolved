// @ts-nocheck
// 1) Real argv limit check. 2) jj diff alone, independent of main-thread exit observation.
import { Session, W, baseEnv, jj, save, stats } from "./lib";
const r = `${W}/repos/stack-5k`;
const chain = jj(r, "--ignore-working-copy", "log", "--no-graph", "--reversed", "-r", "trunk()..stack", "-T", 'commit_id ++ "\n"').trim().split("\n");
const destination = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "trunk()-", "-T", "commit_id").trim();
for (const n of [3800, 3900, 3960, 3980, 4000, 4100]) {
  const source = chain[chain.length - n]!;
  const s = new Session(r);
  const t0 = Date.now(); await s.start(); await s.waitScreen(x => /Ready/.test(x)); await s.settle(t0, { min: 2 });
  s.key("L"); await Bun.sleep(150); s.key("C-a"); s.key("C-k"); s.key(`${source} | ${destination}`, true); await Bun.sleep(100);
  const f = Date.now(); s.key("Enter"); await s.settle(f, { min: 2, timeout: 30000 });
  const a = Date.now(); s.key("r"); await s.settle(a, { min: 1, quiet: 150, timeout: 30000 });
  s.key("Tab"); await Bun.sleep(100); s.key("j"); await Bun.sleep(300);
  const t = Date.now(); s.key("Enter");
  const d = await s.settle(t, { min: 5, timeout: 40000 });
  s.read();
  const text = s.screen();
  const line = text.split("\n").filter(l => /too long|E2BIG|argument|Error|error|ENAMETOOLONG|failed/i.test(l)).join(" | ").replace(/\s+/g, " ").slice(0, 200);
  const procs = s.events.filter(e => e.k === "exit" && e.t >= t).length;
  const preview = /Rebase preview/.test(text);
  save("argv.jsonl", { n, wall: d.done - t, preview, line, procs, timedOut: d.timedOut });
  console.log(n, "preview=", preview, "wall=", d.done - t, "procs=", procs, "timedOut=", d.timedOut, line);
  await s.stop();
}
const repo = `${W}/repos/diffs`;
const id = new Map(jj(repo, "--ignore-working-copy", "log", "--no-graph", "-r", "all()", "-T", 'description.first_line() ++ " " ++ commit_id ++ "\n"').trim().split("\n").map(l => { const i = l.lastIndexOf(" "); return [l.slice(0, i), l.slice(i + 1)] as const; }));
const targets: [string, string, string][] = ["lines1000", "lines10000", "lines100000", "files1000", "hunks10000", "minified2mb", "noisy400files"].map(l => ["diffs", l, id.get(`huge ${l}`)!]);
const real = await Bun.file(`${W}/results/targets.json`).json();
for (const t of real) targets.push([t.repo, t.label, t.big]);
for (const [name, label, commit] of targets) {
  const once = async () => {
    const start = performance.now();
    const p = Bun.spawn(["jj", "--no-pager", "--color=never", "--ignore-working-copy", "--at-op=@", "diff", "--revision", commit, "--git"], { cwd: `${W}/repos/${name}`, env: baseEnv, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await p.exited; return performance.now() - start;
  };
  await once(); const xs = []; for (let i = 0; i < 5; i++) xs.push(await once());
  const s = stats(xs); save("micro.jsonl", { label: `jj diff alone: ${label}`, repo: name, ...s });
  console.log(`diff alone ${label} med=${s.median.toFixed(0)} [${s.min.toFixed(0)}..${s.max.toFixed(0)}]`);
}
