// @ts-nocheck
// A/B of the helper: same app build, helper off and on, with the order alternated per target so drift hits both modes.
import { readFileSync } from "node:fs";
import { W, jj, sh } from "./lib";
const run = async (mode: string, script: string, env: Record<string, string>, ...args: string[]) => {
  console.log(`# ${mode} ${script} ${args.join(" ").slice(0, 100)}`);
  const p = Bun.spawn(["bun", "run", script, ...args], { cwd: import.meta.dir, env: { ...process.env, ...env, AB_MODE: mode }, stdout: "inherit", stderr: "inherit" });
  await p.exited;
};
let flip = false;
const both = async (go: (mode: string) => Promise<void>) => { flip = !flip; for (const mode of flip ? ["off", "on"] : ["on", "off"]) await go(mode); };
const FULL = "startup,idle,reload-default,reload-all,select,search-default,search-all,picker";
for (const [repo, flows] of [["chain-400", FULL], ["git", FULL], ["rust", FULL], ["lin-1m", FULL], ["linux", FULL], ["br-50k", "startup,idle,reload-default,reload-all,select"]] as const) {
  await both(mode => run(mode, "flows.ts", {}, repo, flows));
}
const diffs = `${W}/repos/diffs`;
const rows = jj(diffs, "--ignore-working-copy", "log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ " " ++ description.first_line() ++ "\n"').trim().split("\n").map(l => { const i = l.indexOf(" "); return [l.slice(i + 1), l.slice(0, i)] as const; });
const id = new Map(rows);
for (const label of ["lines10000", "lines100000", "files2000", "noisy400files"]) await both(mode => run(mode, "flows2.ts", { REPEAT: "5" }, "diff", "diffs", label, id.get(`small after ${label}`)!, id.get(`huge ${label}`)!));
for (const t of JSON.parse(readFileSync(`${W}/results/targets.json`, "utf8"))) await both(mode => run(mode, "flows2.ts", { REPEAT: "5" }, "diff", t.repo, t.label, t.small, t.big));
{
  const r = `${W}/repos/stack-1k`;
  const source = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "roots(trunk()..stack)", "-T", "commit_id").trim();
  const destination = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "trunk()-", "-T", "commit_id").trim();
  await both(mode => run(mode, "flows2.ts", { REPEAT: "5" }, "rebase", "stack-1k", source, destination, "stack-1k"));
}
for (const name of ["rust", "linux"]) {
  const r = `${W}/repos/${name}`;
  const branch = sh(["git", "rev-parse", "--verify", "-q", "origin/main"], r).code === 0 ? "origin/main" : "origin/master";
  const before = jj(r, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id").trim();
  const destination = sh(["git", "rev-parse", `${branch}~1000`], r).out.trim();
  for (let i = 0; i < 10; i++) { await Bun.write(`${r}/bench-stack-${i}.txt`, `${i}\n`); jj(r, "commit", "-m", `bench stack ${i}`); }
  const source = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "roots(trunk()..@-)", "-T", "commit_id").trim();
  await both(mode => run(mode, "flows2.ts", { REPEAT: "5" }, "rebase", name, source, destination, `${name}-stack10`));
  jj(r, "op", "restore", before);
}
console.log("queue-ab done");
