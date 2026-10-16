import { terminalText } from "../terminal-text";

export interface RunOptions {
  /** Milliseconds before the command is killed; null waits indefinitely (network operations, which the caller can cancel). */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

export async function run(path: string, args: string[], diagnostics = false, env: NodeJS.ProcessEnv = {}, options: RunOptions = {}): Promise<string> {
  if (!Bun.which("jj")) throw new Error("jj is not installed. Install Jujutsu, then run jj-evolved again.");
  const proc = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
    // Its own process group, so stopping it also stops the git and ssh processes jj starts for remotes.
    cwd: path, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    env: { ...process.env, JJ_INTERACTIVE: "0", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  const { timeoutMs = 30_000, signal } = options;
  let timedOut = false;
  const stop = () => { try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill(); } };
  const timer = timeoutMs === null ? undefined : setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0 && signal?.aborted) throw new CancelledError();
    if (code !== 0 && timedOut) throw new Error(`jj command exceeded ${(timeoutMs ?? 0) / 1000} seconds and was stopped.${stderr.trim() ? `\n${terminalText(stderr.trim())}` : ""}`);
    if (code !== 0) throw new Error(terminalText(stderr.trim()) || "jj command failed.");
    return diagnostics ? stdout + stderr : stdout;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
}

/** Thrown when a command was stopped through its abort signal. */
export class CancelledError extends Error {
  constructor() { super("Cancelled."); this.name = "CancelledError"; }
}
