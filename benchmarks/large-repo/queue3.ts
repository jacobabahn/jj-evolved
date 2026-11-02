// @ts-nocheck
// Large-diff and rebase-preview flows. Real large commits come from targets.json, written after the search reruns.
import { readFileSync } from "node:fs";
import { W, jj, sh } from "./lib";
const flow = async (env: Record<string, string>, ...args: string[]) => {
  console.log("#", args.join(" ").slice(0, 120));
  const p = Bun.spawn(["bun", "run", "flows2.ts", ...args], { cwd: `${W}/scripts`, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" });
  await p.exited;
};
const repo = `${W}/repos/diffs`;
const rows = jj(repo, "--ignore-working-copy", "log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ " " ++ description.first_line() ++ "\n"').trim().split("\n").map(l => { const i = l.indexOf(" "); return [l.slice(i + 1), l.slice(0, i)] as const; });
const id = new Map(rows);
for (const label of ["lines1000", "lines10000", "lines100000", "files100", "files1000", "files2000", "hunks1000", "hunks10000", "minified2mb", "noisy400files"]) {
  await flow({ REPEAT: "5" }, "diff", "diffs", label, id.get(`small after ${label}`)!, id.get(`huge ${label}`)!);
}
for (const t of JSON.parse(readFileSync(`${W}/results/targets.json`, "utf8"))) await flow({ REPEAT: "5" }, "diff", t.repo, t.label, t.small, t.big);
for (const name of ["stack-100", "stack-1k", "stack-5k", "stack-20k"]) {
  const r = `${W}/repos/${name}`;
  const source = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "roots(trunk()..stack)", "-T", "commit_id").trim();
  const destination = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "trunk()-", "-T", "commit_id").trim();
  await flow({ REPEAT: name === "stack-20k" ? "3" : "5" }, "rebase", name, source, destination, name);
}
for (const name of ["rust", "linux", "git"]) {
  const r = `${W}/repos/${name}`;
  const branch = sh(["git", "rev-parse", "--verify", "-q", "origin/main"], r).code === 0 ? "origin/main" : "origin/master";
  const before = jj(r, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id").trim();
  const destination = sh(["git", "rev-parse", `${branch}~1000`], r).out.trim();
  for (let i = 0; i < 10; i++) { await Bun.write(`${r}/bench-stack-${i}.txt`, `${i}\n`); jj(r, "commit", "-m", `bench stack ${i}`); }
  const source = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "roots(trunk()..@-)", "-T", "commit_id").trim();
  await flow({ REPEAT: "5" }, "rebase", name, source, destination, `${name}-stack10`);
  jj(r, "op", "restore", before);
}
console.log("queue3 done");
