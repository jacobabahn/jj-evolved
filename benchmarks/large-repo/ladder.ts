// @ts-nocheck
// jj-only timing ladder with stdout to /dev/null. Splits process startup, repo load, walk, template.
import { W, baseEnv, save, stats } from "./lib";
const only = process.argv.slice(2);
const FULL = `'{' ++ '"commitId":' ++ json(commit_id) ++ ',"changeId":' ++ json(change_id) ++ ',"changePrefix":' ++ json(change_id.shortest().prefix()) ++ ',"description":' ++ json(description) ++ ',"author":' ++ json(author.name()) ++ ',"bookmarks":' ++ json(stringify(bookmarks)) ++ ',"parents":' ++ json(parents.map(|p| p.commit_id())) ++ ',"workingCopy":' ++ json(current_working_copy) ++ ',"conflict":' ++ json(conflict) ++ '}\n'`;
const NOPREFIX = FULL.replace(`json(change_id.shortest().prefix())`, `json(change_id)`);
const LOG = FULL + ` ++ '::jj-evolved-description::\n'`;
const RO = ["--ignore-working-copy", "--at-op=@"];
const BM = `'[' ++ json(name) ++ ',' ++ json(if(remote, stringify(remote), "")) ++ ',' ++ json(added_targets.map(|c| c.commit_id())) ++ ',' ++ json(conflict) ++ ',' ++ json(tracked) ++ ']\n'`;
const commands: [string, string[]][] = [
  ["version", ["--version"]],
  ["root", ["root"]],
  ["config-get", ["--ignore-working-copy", "config", "get", "revsets.log"]],
  ["null-query", [...RO, "log", "--no-graph", "-r", "none()", "-T", '""']],
  ["op-id-readonly", [...RO, "op", "log", "--no-graph", "--limit", "1", "-T", "id"]],
  ["op-id-snapshot(poll)", ["op", "log", "--no-graph", "--limit", "1", "-T", "id"]],
  ["status", ["status"]],
  ["log-default-200", [...RO, "log", "--config", "ui.log-word-wrap=false", "--limit", "200", "--revisions", "builtin_log()", "--template", LOG]],
  ["log-all-200-graph", [...RO, "log", "--config", "ui.log-word-wrap=false", "--limit", "200", "--revisions", "all()", "--template", LOG]],
  ["probe-all-201", [...RO, "log", "--no-graph", "--limit", "201", "-r", "all()", "-T", '"x"']],
  ["bookmark-list", [...RO, "bookmark", "list", "--all-remotes", "-T", BM]],
  ["diff-trunk", [...RO, "diff", "--revision", "trunk()", "--git"]],
  ["all:debug-revset", ["--ignore-working-copy", "debug", "revset", "all()"]],
  ["all:empty-template", [...RO, "log", "--no-graph", "-r", "all()", "-T", '""']],
  ["all:commit-id", [...RO, "log", "--no-graph", "-r", "all()", "-T", 'commit_id ++ "\\n"']],
  ["all:no-prefix", [...RO, "log", "--no-graph", "-r", "all()", "-T", NOPREFIX]],
  ["all:full-template", [...RO, "log", "--no-graph", "-r", "all()", "-T", FULL]],
];
async function once(repo: string, args: string[]) {
  const t = performance.now();
  const p = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], { cwd: repo, env: { ...baseEnv, JJ_INTERACTIVE: "0" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const code = await p.exited, ms = performance.now() - t, u = p.resourceUsage();
  return { ms, code, cpu: (Number(u.cpuTime.user) + Number(u.cpuTime.system)) / 1000, rss: u.maxRSS / 1024 / 1024 };
}
const repos = only.length ? only : ["lin-1k", "lin-10k", "lin-100k", "lin-1m", "files-10k", "files-100k", "files-300k", "br-1k", "br-10k", "br-50k", "stack-5k", "jj", "git", "rust", "linux"];
for (const name of repos) {
  for (const [cmd, args] of commands) {
    const repo = `${W}/repos/${name}`;
    const warm = await once(repo, args);                // discarded warm-up, also sizes the repeat count
    const k = warm.ms > 20_000 ? 3 : warm.ms > 3000 ? 5 : warm.ms > 300 ? 10 : 20;
    const runs = []; for (let i = 0; i < k; i++) runs.push(await once(repo, args));
    const s = stats(runs.map(r => r.ms)), c = stats(runs.map(r => r.cpu));
    const rec = { repo: name, cmd, ...s, cpuMedian: c.median, rss: Math.max(...runs.map(r => r.rss)), code: runs[0]!.code, warm: warm.ms };
    save("ladder.jsonl", rec);
    console.log(`${name.padEnd(11)} ${cmd.padEnd(22)} n=${s.n} med=${s.median.toFixed(1)} [${s.min.toFixed(1)}..${s.max.toFixed(1)}] cpu=${c.median.toFixed(0)} rss=${rec.rss.toFixed(0)}MB rc=${rec.code}`);
  }
}
console.log("ladder done");
