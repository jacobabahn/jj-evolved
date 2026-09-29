// Records two builds of the app in a real terminal (tmux) running the same scripted keystrokes,
// then writes metrics, a summary table, and optional before/after GIFs. See docs/ui-tooling.md.
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TerminalScenario } from "./terminal-scenarios";

export const root = resolve(import.meta.dir, "..");
const size = { cols: 150, rows: 40, sidebar: 34 };

export type App = { dir: string; label: string; cleanup: () => Promise<void> };
export type JjCall = { at: number; args: string };
export type Burst = { label: string; start: number; lastKey: number; keys: number };
export type Sample = { at: number; text: string };
export type RunMetrics = {
  label: string;
  startupMs: number;
  /** jj processes after "Ready" appeared and before the first key. */
  idleJj: number;
  jj: { total: number; byCommand: Record<string, number> };
  bursts: { label: string; keys: number; catchUpMs: number; jj: number }[];
  watched: Record<string, number>;
};

// ---------- pure helpers (unit tested) ----------

const valueFlags = new Set(["--at-op", "--at-operation", "--config", "-R", "--repository", "--color", "--limit", "-n", "-r", "--revision", "--revisions", "-T", "--template", "-m", "--message"]);
const groups = new Set(["op", "operation", "bookmark", "git", "workspace", "config", "file"]);

/** Names the jj subcommand of a logged argument string, e.g. "op log" or "diff". */
export function jjCommand(args: string): string {
  const words: string[] = [];
  const tokens = args.trim().split(/\s+/);
  for (let i = 0; i < tokens.length && words.length < 2; i++) {
    const token = tokens[i]!;
    if (token.startsWith("-")) { if (valueFlags.has(token)) i++; continue; }
    words.push(token);
    if (!groups.has(token)) break;
  }
  return words.join(" ") || "(none)";
}

export function parseJjLog(text: string): JjCall[] {
  return text.split("\n").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    return { at: Number(line.slice(0, tab).replace(",", ".")) * 1000, args: line.slice(tab + 1) };
  });
}

/** Time from `from` until the screen starts a quiet period of `quiet` ms (0 if it never changed). */
export function catchUp(changes: number[], from: number, until: number, quiet = 300): number {
  const after = changes.filter(at => at > from && at <= until);
  for (const [index, at] of after.entries()) if ((after[index + 1] ?? until) - at >= quiet) return at - from;
  return after.length ? after.at(-1)! - from : 0;
}

/** Drops tmux's exit screen so a GIF ends on the app instead of a blank terminal. */
export function trimCast(text: string): string {
  const [header = "", ...events] = text.split("\n").filter(Boolean);
  const end = events.findIndex(line => /exited\]|detached/.test(JSON.parse(line)[2] ?? ""));
  const kept = end < 0 ? events : events.slice(0, end);
  while (kept.length && (JSON.parse(kept.at(-1)!)[2] ?? "").includes("\u001b[2J")) kept.pop();
  return [header, ...kept].join("\n") + "\n";
}

export function metrics(label: string, startupMs: number, ready: number, calls: JjCall[], bursts: Burst[], samples: Sample[], end: number, watch: string[] = []): RunMetrics {
  const byCommand: Record<string, number> = {};
  for (const call of calls) byCommand[jjCommand(call.args)] = (byCommand[jjCommand(call.args)] ?? 0) + 1;
  const changes = samples.slice(1).map(sample => sample.at);
  return {
    label, startupMs, jj: { total: calls.length, byCommand },
    idleJj: calls.filter(call => call.at >= ready && call.at < (bursts[0]?.start ?? end)).length,
    bursts: bursts.map((burst, index) => {
      const until = bursts[index + 1]?.start ?? end;
      return { label: burst.label, keys: burst.keys, catchUpMs: Math.round(catchUp(changes, burst.lastKey, until)),
        jj: calls.filter(call => call.at >= burst.start && call.at < until).length };
    }),
    watched: Object.fromEntries(watch.map(text => [text, samples.filter(sample => sample.text.includes(text)).length])),
  };
}

export function summary(scenario: TerminalScenario, before: RunMetrics, after: RunMetrics, gif: boolean): string {
  const row = (name: string, a: string | number, b: string | number) => `| ${name} | ${a} | ${b} |`;
  const commands = [...new Set([...Object.keys(before.jj.byCommand), ...Object.keys(after.jj.byCommand)])]
    .sort((x, y) => (before.jj.byCommand[y] ?? 0) - (before.jj.byCommand[x] ?? 0));
  return [
    `### ${scenario.title}`, "",
    `| Metric | Before (${before.label}) | After (${after.label}) |`, "| --- | ---: | ---: |",
    row("Startup until \"Ready\"", `${before.startupMs} ms`, `${after.startupMs} ms`),
    row("jj processes while idle before the first key", before.idleJj, after.idleJj),
    ...before.bursts.flatMap((burst, index) => {
      const other = after.bursts[index];
      return [row(`Catch-up after ${burst.label}`, `${burst.catchUpMs} ms`, `${other?.catchUpMs ?? "–"} ms`),
        row(`jj processes during ${burst.label}`, burst.jj, other?.jj ?? "–")];
    }),
    row("**jj processes (total)**", `**${before.jj.total}**`, `**${after.jj.total}**`),
    ...commands.map(command => row(`&nbsp;&nbsp;\`jj ${command}\``, before.jj.byCommand[command] ?? 0, after.jj.byCommand[command] ?? 0)),
    ...Object.keys(before.watched).map(text => row(`Screen states showing "${text}"`, before.watched[text] ?? 0, after.watched[text] ?? 0)),
    "", "Catch-up: time from the last key of a burst until the app pane stays unchanged for 300 ms.",
    ...(gif ? ["", "![Before and after](compare.gif)"] : []), "",
  ].join("\n");
}

// ---------- process helpers ----------

const sleep = (ms: number) => Bun.sleep(ms);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function exec(command: string[], options: { cwd?: string; env?: Record<string, string | undefined>; allowFailure?: boolean } = {}) {
  const proc = Bun.spawn(command, { cwd: options.cwd, env: options.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !options.allowFailure) throw new Error(`${command.join(" ")} failed:\n${stderr.trim()}`);
  return stdout;
}

export function agg() { return process.env.AGG ?? Bun.which("agg"); }

export function missingTools(gif: boolean): string[] {
  const tools: [string, boolean, string][] = [
    ["git", Boolean(Bun.which("git")), "install Git"],
    ["jj", Boolean(Bun.which("jj")), "install Jujutsu"],
    ["tmux", Boolean(Bun.which("tmux")), "install tmux (apt/brew install tmux)"],
    ...(gif ? [
      ["asciinema", Boolean(Bun.which("asciinema")), "uv tool install asciinema (or pipx install asciinema)"],
      ["agg", Boolean(agg()), "download from https://github.com/asciinema/agg/releases, put it on PATH or set AGG"],
      ["ffmpeg", Boolean(Bun.which("ffmpeg")), "install ffmpeg"],
    ] as [string, boolean, string][] : []),
  ];
  return tools.filter(([, found]) => !found).map(([name, , hint]) => `${name}: ${hint}`);
}

// ---------- builds and repository ----------

/** "." is the current working tree (including uncommitted edits); anything else is a Git ref checked out into a temporary worktree. */
export async function prepareApp(ref: string, work: string): Promise<App> {
  if (ref === ".") {
    const branch = (await exec(["git", "branch", "--show-current"], { cwd: root })).trim() || "detached";
    return { dir: root, label: `working tree (${branch})`, cleanup: async () => {} };
  }
  const commit = (await exec(["git", "rev-parse", "--verify", `${ref}^{commit}`], { cwd: root })).trim();
  const dir = join(work, `app-${commit.slice(0, 12)}`);
  if (!existsSync(dir)) {
    await exec(["git", "worktree", "add", "--detach", dir, commit], { cwd: root });
    await exec(["bun", "install", "--frozen-lockfile"], { cwd: dir });
  }
  return { dir, label: `${ref} (${commit.slice(0, 7)})`,
    cleanup: async () => { await exec(["git", "worktree", "remove", "--force", dir], { cwd: root, allowFailure: true }); } };
}

export async function jjConfig(work: string) {
  const path = join(work, "jj-config.toml");
  await writeFile(path, `[user]\nname = "Compare Bot"\nemail = "compare@example.com"\n`);
  return path;
}

/** A linear history of `commits` changes, cached in the temp directory between runs. */
export async function history(commits: number, config: string, log: (text: string) => void = () => {}) {
  const dir = join(tmpdir(), `jj-evolved-compare-history-${commits}`);
  // The marker sits beside the repository so it never appears as a working-copy change.
  const complete = `${dir}.complete`;
  if (existsSync(complete)) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const env = { ...process.env, JJ_CONFIG: config };
  const jj = (...args: string[]) => exec(["jj", "--no-pager", "--color=never", ...args], { cwd: dir, env });
  await jj("git", "init");
  for (let index = 1; index <= commits; index++) {
    await Bun.write(join(dir, `f${index % 20}.txt`), `${index}\n`);
    await jj("commit", "-m", `change ${index}`);
    if (index % 100 === 0) log(`  built ${index}/${commits} commits`);
  }
  await jj("bookmark", "create", "main", "-r", "@-");
  await writeFile(complete, "");
  return dir;
}

// ---------- recording ----------

export type RecordOptions = {
  app: App; side: "before" | "after"; scenario: TerminalScenario; history: string;
  work: string; out: string; config: string; theme: string; gif: boolean;
};

export async function record({ app, side, scenario, history, work, out, config, theme, gif }: RecordOptions): Promise<RunMetrics> {
  const run = join(work, side);
  await rm(run, { recursive: true, force: true });
  await mkdir(join(run, "bin"), { recursive: true });
  await mkdir(join(run, "xdg"), { recursive: true });
  const repo = join(run, "repo");
  await cp(history, repo, { recursive: true });
  const jjLog = join(run, "jj.log");
  const keyLog = join(run, "keys.log");
  await writeFile(jjLog, "");
  await writeFile(keyLog, "");
  // A PATH shim logs every jj process the app starts, then runs the real jj.
  const wrapper = join(run, "bin", "jj");
  await writeFile(wrapper, `#!/usr/bin/env bash\nprintf '%s\\t%s\\n' "\${EPOCHREALTIME:-$(date +%s)}" "$(printf '%s ' "$@" | tr '\\n' ' ' | cut -c1-240)" >> ${quote(jjLog)}\nexec ${quote(Bun.which("jj")!)} "$@"\n`, { mode: 0o755 });

  const socket = `jj-evolved-compare-${process.pid}-${side}`;
  const tmux = (...args: string[]) => exec(["tmux", "-L", socket, "-f", "/dev/null", ...args]);
  const launch = `cd ${quote(app.dir)} && exec env PATH=${quote(join(run, "bin"))}:"$PATH" JJ_CONFIG=${quote(config)} XDG_CONFIG_HOME=${quote(join(run, "xdg"))} JJ_EVOLVED_THEME=${quote(theme)} bun run src/index.ts ${quote(repo)}`;
  const started = Date.now();
  await tmux("new-session", "-d", "-s", "compare", "-x", String(size.cols), "-y", String(size.rows), launch);
  const label = `${side === "before" ? "BEFORE" : "AFTER"} · ${app.label}`.replaceAll("#", "##");
  for (const [option, value] of [["status", "on"], ["status-left", ` ${label} `], ["status-left-length", "120"], ["status-right", ""],
    ["window-status-format", ""], ["window-status-current-format", ""], ["status-style", "bg=colour24,fg=white,bold"]] as const) {
    await tmux("set-option", "-t", "compare", option, value);
  }
  await tmux("split-window", "-h", "-t", "compare", "-l", String(size.sidebar), `exec bun ${quote(join(import.meta.dir, "terminal-monitor.ts"))} ${quote(jjLog)} ${quote(keyLog)}`);
  await tmux("select-pane", "-t", "compare:0.0");
  const cast = join(out, `${side}.cast`);
  const recorder = gif ? Bun.spawn(["asciinema", "rec", "--quiet", "--overwrite", "--command", `tmux -L ${socket} attach -t compare`, ...(await asciinemaSize()), cast],
    { env: { ...process.env, TERM: "xterm-256color" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" }) : null;

  const pane = () => tmux("capture-pane", "-p", "-t", "compare:0.0");
  let startupMs = -1;
  while (Date.now() - started < 30_000) {
    if ((await pane()).includes("Ready")) { startupMs = Date.now() - started; break; }
    await sleep(20);
  }
  if (startupMs < 0) throw new Error(`${app.label} did not show "Ready" within 30 s:\n${await pane()}`);
  await sleep(500);

  // Sample the app pane throughout the scenario to time when it catches up with input.
  const samples: Sample[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const text = await pane();
      if (samples.at(-1)?.text !== text) samples.push({ at: Date.now(), text });
      await sleep(10);
    }
  })();
  const bursts: Burst[] = [];
  for (const step of scenario.steps) {
    if ("wait" in step) { await sleep(step.wait); continue; }
    const burst: Burst = { label: step.label, start: Date.now(), lastKey: 0, keys: step.keys.length };
    for (const [index, key] of step.keys.entries()) {
      await tmux("send-keys", "-t", "compare:0.0", key);
      burst.lastKey = Date.now();
      await appendFile(keyLog, `${burst.lastKey}\t${key}\n`);
      if (index < step.keys.length - 1) await sleep(step.interval);
    }
    bursts.push(burst);
  }
  const end = Date.now();
  sampling = false;
  await sampler;
  await exec(["tmux", "-L", socket, "kill-server"], { allowFailure: true });
  if (recorder) await Promise.race([recorder.exited, sleep(10_000).then(() => recorder.kill())]);
  const calls = parseJjLog(await Bun.file(jjLog).text()).filter(call => call.at >= started);
  return metrics(app.label, startupMs, started + startupMs, calls, bursts, samples, end, scenario.watch);
}

async function asciinemaSize() {
  const version = await exec(["asciinema", "--version"]);
  return /asciinema 2\./.test(version)
    ? ["--cols", String(size.cols), "--rows", String(size.rows)]
    : ["--window-size", `${size.cols}x${size.rows}`, "--output-format", "asciicast-v2"];
}

export async function renderGifs(out: string) {
  const renderer = agg()!;
  for (const side of ["before", "after"]) {
    const cast = join(out, `${side}.cast`);
    await Bun.write(cast, trimCast(await Bun.file(cast).text()));
    await exec([renderer, "--font-size", "13", "--fps-cap", "20", "--idle-time-limit", "3", cast, join(out, `${side}.gif`)]);
  }
  await exec(["ffmpeg", "-loglevel", "error", "-y", "-i", join(out, "before.gif"), "-i", join(out, "after.gif"), "-filter_complex",
    "[0:v]fps=12[a];[1:v]fps=12[b];[a][b]vstack=inputs=2,scale=iw*0.8:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=none",
    join(out, "compare.gif")]);
}

export async function workDirectory() { return mkdtemp(join(tmpdir(), "jj-evolved-compare-")); }
