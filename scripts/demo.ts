import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!Bun.which("jj")) {
  process.stderr.write("Install Jujutsu first: jj must be on PATH.\n");
  process.exit(1);
}
const directory = await mkdtemp(join(tmpdir(), "jj-evolved-demo-"));
async function jj(...args: string[]) {
  const proc = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
    cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, JJ_CONFIG: "", JJ_USER: "Demo Developer", JJ_EMAIL: "demo@example.com" },
  });
  const [, error, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(error);
}
try {
  await jj("git", "init");
  await jj("config", "set", "--repo", "user.name", "Demo Developer");
  await jj("config", "set", "--repo", "user.email", "demo@example.com");
  await Bun.write(join(directory, "README.md"), "# A small jj workspace\n\nBrowse revisions with j and k.\n");
  await jj("describe", "-m", "Start the workspace");
  await jj("bookmark", "create", "main");
  await jj("new", "-m", "Add a greeting");
  await Bun.write(join(directory, "hello.ts"), 'export const greeting = "Hello, Jujutsu!";\n');
  await jj("bookmark", "create", "greeting");
  await jj("new", "-m", "Polish the greeting");
  await Bun.write(join(directory, "hello.ts"), 'export const greeting = "Hello from jj-evolved!";\n');
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), directory], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
