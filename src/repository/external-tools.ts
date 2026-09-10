import type { InteractiveAction, Revision } from "./model";

async function foreground(root: string, args: string[], env: NodeJS.ProcessEnv, failure: (code: number) => string) {
  const child = Bun.spawn(args, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  const interrupt = () => { child.kill("SIGINT"); };
  process.on("SIGINT", interrupt);
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error(failure(code));
  } finally { process.off("SIGINT", interrupt); }
}

export async function runInteractive(root: string, action: InteractiveAction): Promise<void> {
  const args = action.kind === "squash"
    ? ["squash", "--interactive", "--from", action.revision.commitId, "--into", action.destination.commitId]
    : ["split", "--interactive", "--revision", action.revision.commitId];
  await foreground(root, ["jj", "--no-pager", ...args], { ...process.env, JJ_INTERACTIVE: "1" },
    code => `Interactive ${action.kind} did not complete (exit code ${code}).`);
}

export async function openHunk(root: string, revision: Revision): Promise<void> {
  const executable = Bun.which("hunk", { PATH: process.env.PATH ?? "" });
  if (!executable) throw new Error("Hunk is not installed or is not on PATH. Install it with npm install -g hunkdiff, then try again.");
  await foreground(root, [executable, "show", revision.commitId], process.env, code => `Hunk exited with code ${code}.`);
}
