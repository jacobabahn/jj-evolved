import { terminalText } from "../terminal-text";

export async function run(path: string, args: string[], diagnostics = false, env: NodeJS.ProcessEnv = {}): Promise<string> {
  if (!Bun.which("jj")) throw new Error("jj is not installed. Install Jujutsu, then run jj-evolved again.");
  const proc = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
    cwd: path, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, JJ_INTERACTIVE: "0", ...env },
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(terminalText(stderr.trim()) || "jj command failed or exceeded 30 seconds.");
    return diagnostics ? stdout + stderr : stdout;
  } finally { clearTimeout(timer); }
}
