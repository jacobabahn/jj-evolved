import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { terminalScenarios } from "../tooling/terminal-scenarios";
import { history, jjConfig, missingTools, prepareApp, record, renderGifs, root, summary, workDirectory, type App } from "../tooling/terminal-compare";

const usage = `Usage: bun run compare <scenario> [--before REF] [--after REF] [--out DIR] [--commits N] [--theme NAME] [--no-gif]
       bun run compare list

Records both builds in tmux with identical scripted keystrokes and writes metrics.json, summary.md,
and (unless --no-gif) before.gif, after.gif and a stacked compare.gif.
  --before   Git ref for the baseline (default: origin/main, else main)
  --after    Git ref for the change; "." is the current working tree (default)
  --out      Output directory (default: artifacts/compare/<scenario>)
  --commits  Size of the generated jj history (default: 400)
  --theme    App theme for the recording (default: tokyonight)`;

try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
    before: { type: "string" }, after: { type: "string", default: "." }, out: { type: "string" },
    commits: { type: "string", default: "400" }, theme: { type: "string", default: "tokyonight" },
    "no-gif": { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
  } });
  const [name, ...extra] = positionals;
  if (values.help || !name || extra.length) { console.log(usage); process.exit(values.help ? 0 : 1); }
  if (name === "list") {
    for (const scenario of terminalScenarios) console.log(`${scenario.name.padEnd(14)} ${scenario.title}`);
    process.exit(0);
  }
  const scenario = terminalScenarios.find(item => item.name === name);
  if (!scenario) throw new Error(`Unknown scenario ${JSON.stringify(name)}. Run bun run compare list.`);
  const commits = Number(values.commits);
  if (!Number.isSafeInteger(commits) || commits < 1) throw new Error("--commits must be a positive integer.");
  const gif = !values["no-gif"];
  const missing = missingTools(gif);
  if (missing.length) throw new Error(`Missing tools${gif ? " (use --no-gif to skip recording)" : ""}:\n  ${missing.join("\n  ")}`);
  const before = values.before ?? (Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "origin/main"], { cwd: root }).exitCode === 0 ? "origin/main" : "main");
  const out = resolve(values.out ?? join(root, "artifacts", "compare", scenario.name));
  await mkdir(out, { recursive: true });

  const work = await workDirectory();
  const apps: App[] = [];
  try {
    const config = await jjConfig(work);
    console.log(`Preparing a ${commits}-commit jj history…`);
    const repository = await history(commits, config, console.log);
    for (const ref of [before, values.after]) {
      console.log(`Preparing ${ref}…`);
      apps.push(await prepareApp(ref, work));
    }
    const results = [];
    for (const [index, side] of (["before", "after"] as const).entries()) {
      console.log(`Recording ${side}: ${apps[index]!.label}`);
      results.push(await record({ app: apps[index]!, side, scenario, history: repository, work, out, config, theme: values.theme, gif }));
    }
    if (gif) { console.log("Rendering GIFs…"); await renderGifs(out); }
    const text = summary(scenario, results[0]!, results[1]!, gif);
    await writeFile(join(out, "metrics.json"), JSON.stringify({ scenario: scenario.name, commits, before: results[0], after: results[1] }, null, 2));
    await writeFile(join(out, "summary.md"), text);
    console.log(`\n${text}\nWrote ${out}`);
  } finally {
    for (const app of apps) await app.cleanup();
    await rm(work, { recursive: true, force: true });
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
