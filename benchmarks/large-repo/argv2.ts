// @ts-nocheck
import { Session, W, baseEnv, jj, save } from "./lib";
for (const name of ["stack-3900", "stack-4000", "stack-5k", "stack-20k"]) {
  const r = `${W}/repos/${name}`;
  const source = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "roots(trunk()..stack)", "-T", "commit_id").trim();
  const destination = jj(r, "--ignore-working-copy", "log", "--no-graph", "-r", "trunk()-", "-T", "commit_id").trim();
  const op = jj(r, "--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id").trim();
  for (const flag of ["--source", "--revisions"]) {
    const t = performance.now();
    const p = Bun.spawn(["timeout", "120", "jj", "--no-pager", "--color=never", "--at-op", op, "--no-integrate-operation", "rebase", flag, source, "--onto", destination], { cwd: r, env: baseEnv, stdout: "ignore", stderr: "ignore" });
    const code = await p.exited;
    console.log(name, "rewrite alone", flag, Math.round(performance.now() - t), "rc", code);
    save("argv.jsonl", { name, flag, rewriteMs: performance.now() - t, code });
  }
  for (const scope of ["descendants", "only"]) {
    const s = new Session(r);
    const t0 = Date.now(); await s.start(); await s.waitScreen(x => /Ready/.test(x)); await s.settle(t0, { min: 2 });
    s.key("L"); await Bun.sleep(150); s.key("C-a"); s.key("C-k"); s.key(`${source} | ${destination}`, true); await Bun.sleep(100);
    const f = Date.now(); s.key("Enter"); await s.settle(f, { min: 2, timeout: 30000 });
    const a = Date.now(); s.key("r"); await s.settle(a, { min: 1, quiet: 150, timeout: 30000 });
    if (scope === "descendants") { s.key("Tab"); await Bun.sleep(100); }
    s.key("j"); await Bun.sleep(300);
    const t = Date.now(); s.key("Enter");
    const d = await s.settle(t, { min: 5, timeout: 60000 });
    s.read();
    const text = s.screen();
    const errors = text.split("\n").filter(l => /too long|E2BIG|argument|rror|exceeded|ENAMETOOLONG/i.test(l)).join(" | ").replace(/[│┌┐└┘─\s]+/g, " ").slice(0, 170);
    save("argv.jsonl", { name, scope, wall: d.done - t, preview: /Rebase preview/.test(text), errors, procs: s.events.filter(e => e.k === "exit" && e.t >= t).map(e => e.code) });
    console.log(name, scope, "wall", Math.round(d.done - t), "preview", /Rebase preview/.test(text), errors);
    await s.stop();
  }
}
