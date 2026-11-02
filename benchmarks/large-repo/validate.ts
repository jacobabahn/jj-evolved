// @ts-nocheck
// Is the preload inflating search-open? Same flow timed from the screen only, without and with it. Also main-thread cost without any wrapper.
import { readFileSync } from "node:fs";
import { Session, W, baseEnv, save, stats } from "./lib";
const FULL = `'{' ++ '"commitId":' ++ json(commit_id) ++ ',"changeId":' ++ json(change_id) ++ ',"changePrefix":' ++ json(change_id.shortest().prefix()) ++ ',"description":' ++ json(description) ++ ',"author":' ++ json(author.name()) ++ ',"bookmarks":' ++ json(stringify(bookmarks)) ++ ',"parents":' ++ json(parents.map(|p| p.commit_id())) ++ ',"workingCopy":' ++ json(current_working_copy) ++ ',"conflict":' ++ json(conflict) ++ '}\n'`;
for (const preload of [false, true, false, true]) {
  const xs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = new Session(`${W}/repos/rust`, { preload });
    await s.start(); await s.waitScreen(x => /Ready/.test(x)); await Bun.sleep(700);
    s.key("L"); await Bun.sleep(200); s.key("C-a"); s.key("C-k"); s.key("all()", true); await Bun.sleep(150); s.key("Enter");
    await s.waitScreen(x => x.includes("revset: all()") && x.includes("200 revisions")); await Bun.sleep(400);
    const t = Date.now(); s.key("/");
    await s.waitScreen(x => x.includes("Type to search"), 60000);
    xs.push(Date.now() - t); s.tmux("kill-server"); await Bun.sleep(300);
  }
  const st = stats(xs); save("validate.jsonl", { what: "search-open screen", preload, ...st }); console.log("search-open preload=", preload, st);
}
const mainCpu = () => Number(readFileSync(`/proc/self/task/${process.pid}/schedstat`, "utf8").split(" ")[0]) / 1e6;
const args = ["jj", "--no-pager", "--color=never", "--ignore-working-copy", "--at-op=@", "log", "--no-graph", "-r", "all()", "-T", FULL];
const cwd = `${W}/repos/rust`;
for (let i = 0; i < 4; i++) {
  let t = performance.now(), c = mainCpu();
  const p = Bun.spawn(args, { cwd, env: baseEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [text] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const wall = performance.now() - t, cpu = mainCpu() - c;
  const file = `${W}/tmp/out-${i}.ndjson`;
  t = performance.now();
  await Bun.spawn(args, { cwd, env: baseEnv, stdin: "ignore", stdout: Bun.file(file), stderr: "ignore" }).exited;
  const text2 = await Bun.file(file).text();
  const fileWall = performance.now() - t;
  if (i) { save("validate.jsonl", { what: "read path", wall, mainCpu: cpu, fileWall, chars: text.length }); console.log("pipe wall", Math.round(wall), "main cpu", Math.round(cpu), "| via temp file wall", Math.round(fileWall), "chars", text.length, text2.length); }
}
