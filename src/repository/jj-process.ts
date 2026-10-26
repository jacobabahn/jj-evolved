import { terminalText } from "../terminal-text";

export interface RunOptions {
  /** Milliseconds before the command is killed. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A backstop for fetch and push, which the user cancels with Escape: long enough for a large fetch, short enough that a hung connection ends. */
export const NETWORK_TIMEOUT_MS = 10 * 60_000;

export async function run(path: string, args: string[], diagnostics = false, env: NodeJS.ProcessEnv = {}, options: RunOptions = {}): Promise<string> {
  if (!Bun.which("jj")) throw new Error("jj is not installed. Install Jujutsu, then run jj-evolved again.");
  if (options.signal?.aborted) throw new CancelledError(false);
  const proc = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
    // Every jj leads its own process group (setsid), so a timeout or cancellation signals the whole group and also
    // stops the git and ssh processes jj starts; killing only jj leaves them running, and a cancelled push could
    // still complete. Detaching also takes jj out of the terminal's session, so Ctrl-C and closing the terminal no
    // longer reach it. Instead the app cancels network commands when it quits, and every command has a timeout.
    cwd: path, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    env: { ...process.env, JJ_INTERACTIVE: "0", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  const { timeoutMs = 30_000, signal } = options;
  let timedOut = false;
  const stop = () => { try { process.kill(-proc.pid, "SIGTERM"); } catch { proc.kill(); } };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0 && signal?.aborted) throw new CancelledError(true);
    if (code !== 0 && timedOut) throw new Error(`jj command exceeded ${timeoutMs >= 60_000 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs / 1000} seconds`} and was stopped.${stderr.trim() ? `\n${terminalText(stderr.trim())}` : ""}`);
    if (code !== 0) throw new Error(terminalText(stderr.trim()) || "jj command failed.");
    return diagnostics ? stdout + stderr : stdout;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
}

/** Thrown when a command was stopped through its abort signal; `started` is false when it was cancelled before it ran. */
export class CancelledError extends Error {
  constructor(readonly started: boolean) { super("Cancelled."); this.name = "CancelledError"; }
}
