// @ts-nocheck
// Costs outside jj and comparisons for no-Rust fixes. Each row: n, median, range.
import { readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { W, baseEnv, save, stats, APP, sh } from "./lib";
const RO = ["--ignore-working-copy", "--at-op=@"];
async function timeAsync(label: string, repo: string, n: number, fn: () => Promise<unknown> | unknown, extra: object = {}) {
  await fn();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t); }
  const s = stats(xs); save("micro.jsonl", { label, repo, ...s, ...extra });
  console.log(`${repo.padEnd(9)} ${label.padEnd(44)} n=${s.n} med=${s.median.toFixed(s.median < 1 ? 3 : 1)} [${s.min.toFixed(s.min < 1 ? 3 : 1)}..${s.max.toFixed(1)}]`);
}
const jjRun = (repo: string, args: string[], stdout: "ignore" | "pipe" = "ignore") => async () => {
  const p = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], { cwd: `${W}/repos/${repo}`, env: baseEnv, stdin: "ignore", stdout, stderr: "ignore" });
  if (stdout === "pipe") await new Response(p.stdout as ReadableStream).text();
  await p.exited;
};
await timeAsync("spawn /bin/true (floor)", "-", 50, async () => { await Bun.spawn(["/bin/true"], { stdout: "ignore", stderr: "ignore" }).exited; });
await timeAsync("Bun.which(jj)", "-", 200, () => Bun.which("jj"));
for (const repo of ["lin-1k", "git", "rust", "linux", "br-50k", "files-300k"]) {
  const root = `${W}/repos/${repo}`;
  await timeAsync("poll: readdir op_heads (no spawn)", repo, 200, () => readdirSync(`${root}/.jj/repo/op_heads/heads`));
  await timeAsync("poll: op log --ignore-working-copy", repo, 20, jjRun(repo, [...RO, "op", "log", "--no-graph", "--limit", "1", "-T", "id"]));
  await timeAsync("poll: op log (current, snapshots)", repo, 20, jjRun(repo, ["op", "log", "--no-graph", "--limit", "1", "-T", "id"]));
  await timeAsync("util snapshot", repo, 20, jjRun(repo, ["util", "snapshot"]));
}
// Server-side search and bounded loads versus loading every revision.
const FULL = `'{' ++ '"commitId":' ++ json(commit_id) ++ ',"changeId":' ++ json(change_id) ++ ',"changePrefix":' ++ json(change_id.shortest().prefix()) ++ ',"description":' ++ json(description) ++ ',"author":' ++ json(author.name()) ++ ',"bookmarks":' ++ json(stringify(bookmarks)) ++ ',"parents":' ++ json(parents.map(|p| p.commit_id())) ++ ',"workingCopy":' ++ json(current_working_copy) ++ ',"conflict":' ++ json(conflict) ++ '}\n'`;
for (const repo of ["git", "rust", "linux"]) {
  const n = repo === "linux" ? 5 : 10;
  await timeAsync("search: all() limit 5000", repo, n, jjRun(repo, [...RO, "log", "--no-graph", "--limit", "5000", "-r", "all()", "-T", FULL], "pipe"));
  await timeAsync("search: desc filter limit 200 (common)", repo, n, jjRun(repo, [...RO, "log", "--no-graph", "--limit", "200", "-r", 'description(substring-i:"fix")', "-T", FULL], "pipe"));
  await timeAsync("search: desc filter limit 200 (rare)", repo, repo === "linux" ? 3 : 5, jjRun(repo, [...RO, "log", "--no-graph", "--limit", "200", "-r", 'description(substring-i:"zzqxv")', "-T", FULL], "pipe"));
}
// Real parser, fed captured output: the product module with Bun.spawn stubbed to replay a file.
const { logRevisions } = await import(`${APP}/src/repository/log-snapshot.ts`);
for (const repo of ["jj", "git", "lin-100k", "rust", "linux"]) {
  const file = `${W}/tmp/all-${repo}.ndjson`;
  const r = Bun.spawnSync(["jj", "--no-pager", "--color=never", ...RO, "log", "--no-graph", "-r", "all()", "-T", FULL], { cwd: `${W}/repos/${repo}`, env: baseEnv, stdout: Bun.file(file), stderr: "ignore" });
  const size = Bun.file(file).size;
  const real = Bun.spawn;
  const empty = () => new Response("").body!;
  (Bun as any).spawn = () => ({ stdout: Bun.file(file).stream(), stderr: empty(), exited: Promise.resolve(0), kill() {} });
  const reps = repo === "linux" ? 3 : 5;
  await timeAsync("read captured output only (bytes→string)", repo, reps, async () => { await Bun.file(file).text(); }, { size });
  await timeAsync("real logRevisions over captured output", repo, reps, () => logRevisions("/", "all()"), { size });
  (Bun as any).spawn = real;
  await timeAsync("pipe: jj all() into Bun (text only)", repo, reps, jjRun(repo, [...RO, "log", "--no-graph", "-r", "all()", "-T", FULL], "pipe"));
  await timeAsync("pipe: jj all() to /dev/null", repo, reps, jjRun(repo, [...RO, "log", "--no-graph", "-r", "all()", "-T", FULL]));
  Bun.gc(true);
}
console.log("micro done");
