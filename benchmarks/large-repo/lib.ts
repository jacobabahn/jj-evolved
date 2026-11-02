// @ts-nocheck
// Shared bench driver: tmux launch, keystrokes, trace reading and bucket attribution.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const W = readFileSync("/tmp/jj-bench-path", "utf8").trim();
export const APP = `${W}/app-ab`;
const HELPER = process.env.AB_MODE === "on" ? `${W}/helper-bin/jj-evolved-helper` : "off";
const MODE = process.env.AB_MODE ?? "off";
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const sleep = Bun.sleep;
export const baseEnv: Record<string, string> = { ...(process.env as Record<string, string>), JJ_CONFIG: `${W}/jj-config.toml`, XDG_CONFIG_HOME: `${W}/xdg` };

export function sh(cmd: string[], cwd?: string, env = baseEnv) {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
export function jj(repo: string, ...args: string[]) {
  const r = sh(["jj", "--no-pager", "--color=never", ...args], repo);
  if (r.code) throw new Error(`jj ${args.join(" ")}: ${r.err}`);
  return r.out;
}
export type Ev = any;
export function threadCpu(pid: number) {
  const threads: Record<string, number> = {};
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const comm = readFileSync(`/proc/${pid}/task/${tid}/comm`, "utf8").trim();
      const ns = Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, "utf8").split(" ")[0]);
      const name = tid === String(pid) ? "main" : comm;
      threads[name] = (threads[name] ?? 0) + ns / 1e6;
    } catch {}
  }
  return threads;
}
export function hwm(pid: number) {
  try { return Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024; } catch { return 0; }
}

/** Summed CPU (ms) and largest peak RSS (MB) of the helpers currently under the app. */
export function helperUsage(pid: number) {
  let cpu = 0, rss = 0;
  for (const dir of readdirSync("/proc")) {
    if (!/^\d+$/.test(dir)) continue;
    try {
      if (!readFileSync(`/proc/${dir}/comm`, "utf8").startsWith("jj-evolved-help")) continue;
      const stat = readFileSync(`/proc/${dir}/stat`, "utf8"), f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(f[1]) !== pid) continue;
      cpu += (Number(f[11]) + Number(f[12])) * 10;
      rss = Math.max(rss, hwm(Number(dir)));
    } catch {}
  }
  return { helperCpu: cpu, helperHwm: rss };
}

export class Session {
  socket = `jjb-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  trace: string; pid = 0; offset = 0; events: Ev[] = []; started = 0;
  constructor(readonly repo: string, readonly opts: { heartbeat?: boolean; preload?: boolean; cols?: number; rows?: number } = {}) {
    this.trace = `${W}/tmp/trace-${this.socket}.jsonl`;
    writeFileSync(this.trace, "");
  }
  tmux(...args: string[]) { return sh(["tmux", "-L", this.socket, "-f", "/dev/null", ...args]); }
  key(k: string, literal = false) { this.tmux("send-keys", "-t", "b:0.0", ...(literal ? ["-l"] : []), k); }
  screen() { return this.tmux("capture-pane", "-p", "-t", "b:0.0").out; }
  alive() { return this.pid > 0 && existsSync(`/proc/${this.pid}`); }
  async start() {
    const preload = this.opts.preload === false ? "" : `--preload=${q(`${W}/scripts-ab/preload.ts`)}`;
    const launch = `cd ${q(APP)} && exec env TERM=xterm-256color JJ_CONFIG=${q(`${W}/jj-config.toml`)} XDG_CONFIG_HOME=${q(`${W}/xdg`)} JJ_EVOLVED_THEME=tokyonight JJ_EVOLVED_HELPER=${q(HELPER)} BENCH_TRACE=${q(this.trace)} BENCH_APP=${q(APP)} BENCH_HEARTBEAT=${this.opts.heartbeat === false ? 0 : 1} bun run ${process.env.BENCH_BUNFLAGS ?? ""} ${preload} src/index.ts ${q(this.repo)}`;
    this.started = Date.now();
    this.tmux("new-session", "-d", "-s", "b", "-x", String(this.opts.cols ?? 150), "-y", String(this.opts.rows ?? 40), launch);
    this.pid = Number(this.tmux("display-message", "-p", "-t", "b:0.0", "#{pane_pid}").out.trim());
  }
  read() {
    const text = readFileSync(this.trace, "utf8");
    const fresh = text.slice(this.offset);
    const end = fresh.lastIndexOf("\n") + 1;
    this.offset += end;
    for (const line of fresh.slice(0, end).split("\n")) if (line) this.events.push(JSON.parse(line));
  }
  /** Waits for a screen predicate. Returns the time it first held, or null on timeout. */
  async waitScreen(pred: (s: string) => boolean, timeout = 120_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const s = this.screen();
      if (pred(s)) return Date.now();
      if (!this.alive()) return null;
      await sleep(8);
    }
    return null;
  }
  /** Waits until after `from` nothing but idle polls run, and a later heartbeat proves the main thread is not just blocked. */
  async settle(from: number, { quiet = 300, timeout = 180_000, min = 0, frameAfter = 0 }: { quiet?: number; timeout?: number; min?: number; frameAfter?: number } = {}) {
    const limit = Date.now() + timeout;
    while (Date.now() < limit) {
      await sleep(25);
      this.read();
      const open = new Map<number, Ev>();
      let last = from, hb = 0, spawns = 0, framed = !frameAfter;
      for (const e of this.events) {
        if (e.k === "hb") { hb = Math.max(hb, e.t); continue; }
        if (e.t < from && e.k !== "exit") continue;
        if (e.k === "start") { if (!isPoll(e.args)) { open.set(e.id, e); spawns++; last = Math.max(last, e.t); } }
        else if (e.k === "exit") { if (open.delete(e.id)) last = Math.max(last, e.t); }
        else if (e.k === "root" || e.k === "native") { last = Math.max(last, e.t + e.ms); if (e.t >= frameAfter) framed = true; }
      }
      if (framed && !open.size && spawns >= min && hb - last >= quiet) return { done: last, timedOut: false };
      if (!this.alive()) return { done: last, timedOut: true };
    }
    return { done: Date.now(), timedOut: true };
  }
  async stop() {
    this.tmux("kill-server");
    for (let i = 0; i < 200 && this.alive(); i++) await sleep(10);
    this.read();
  }
}
const isPoll = (args: string) => /^op log --no-graph --limit 1 -T id$/.test(args);

const union = (spans: [number, number][]) => {
  let total = 0, end = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) { if (b > end) { total += b - Math.max(a, end); end = b; } }
  return total;
};

/** Buckets for the window [t0, t1]: trace events + thread CPU deltas. */
export function buckets(s: Session, t0: number, t1: number, cpu0: Record<string, number>, cpu1: Record<string, number>) {
  const starts = new Map<number, Ev>();
  for (const e of s.events) if (e.k === "start") starts.set(e.id, e);
  const procs: { args: string; ms: number; user: number; sys: number; rss: number; t: number; end: number; code: number }[] = [];
  for (const e of s.events) if (e.k === "exit") {
    const a = starts.get(e.id);
    if (a && a.t >= t0 - 1 && a.t <= t1) procs.push({ args: a.args, ms: e.t - a.t, user: e.user ?? 0, sys: e.sys ?? 0, rss: e.rss ?? 0, t: a.t, end: e.t, code: e.code });
  }
  const within = (k: string) => s.events.filter(e => e.k === k && e.t >= t0 - 1 && e.t <= t1);
  const sum = (k: string) => within(k).reduce((n, e) => n + e.ms, 0);
  const rootMs = sum("root"), nativeMs = sum("native");
  const mainCpu = (cpu1.main ?? 0) - (cpu0.main ?? 0);
  const workerCpu = Object.keys(cpu1).filter(k => k !== "main").reduce((n, k) => n + (cpu1[k]! - (cpu0[k] ?? 0)), 0);
  const stalls = within("stall").map(e => e.ms);
  return {
    wall: t1 - t0,
    jjUnion: union(procs.map(p => [p.t, p.end])), jjCount: procs.length, jjCpu: procs.reduce((n, p) => n + p.user + p.sys, 0),
    jjSum: procs.reduce((n, p) => n + p.ms, 0), jjMaxRss: Math.max(0, ...procs.map(p => p.rss)) / 1024 / 1024,
    procs: procs.map(p => ({ args: p.args.slice(0, 60), ms: p.ms, cpu: Math.round(p.user + p.sys), code: p.code })),
    mainCpu, workerCpu, rootMs, nativeMs, renderMs: rootMs + nativeMs, tsMs: Math.max(0, mainCpu - rootMs - nativeMs),
    frames: within("native").length, maxStall: Math.max(0, ...stalls),
    setSnapshotMs: sum("setSnapshot"), previewMs: sum("previewContent"),
  };
}
export const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, median: at(0.5), min: s[0]!, max: s.at(-1)! };
};
export function save(file: string, record: object) { appendFileSync(`${W}/results-ab/${file}`, JSON.stringify({ at: Date.now(), mode: MODE, load: readFileSync("/proc/loadavg", "utf8").split(" ")[0], ...record }) + "\n"); }
