// @ts-nocheck
// Colocated (the default) vs non-colocated: the same poll on copies of the same repositories.
import { W, baseEnv, jj, save, stats } from "./lib";
for (const name of ["br-50k", "rust"]) {
  const copy = `${W}/repos/${name}-nocolo`;
  Bun.spawnSync(["cp", "-a", `${W}/repos/${name}`, copy]);
  console.log(jj(copy, "git", "colocation", "disable").trim().slice(0, 80));
  for (const [label, repo] of [["colocated", `${W}/repos/${name}`], ["non-colocated", copy]] as const) {
    const once = async () => { const t = performance.now(); await Bun.spawn(["jj", "--no-pager", "--color=never", "op", "log", "--no-graph", "--limit", "1", "-T", "id"], { cwd: repo, env: baseEnv, stdout: "ignore", stderr: "ignore" }).exited; return performance.now() - t; };
    await once(); const xs = []; for (let i = 0; i < 20; i++) xs.push(await once());
    const s = stats(xs); save("micro.jsonl", { label: `poll ${label}`, repo: name, ...s }); console.log(name, label, s);
  }
}
