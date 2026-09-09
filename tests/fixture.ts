import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "jj-evolved-test-"));
  const env = { ...process.env, JJ_CONFIG: "", JJ_USER: "Test User", JJ_EMAIL: "test@example.com" };
  async function jj(...args: string[]) {
    const proc = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
      cwd: path, env, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(err);
    return out;
  }
  try {
    await jj("git", "init");
    await jj("config", "set", "--repo", "user.name", "Test User");
    await jj("config", "set", "--repo", "user.email", "test@example.com");
    await Bun.write(join(path, "hello.txt"), "hello from jj-evolved\n");
    await jj("describe", "-m", "Initial feature");
    await jj("bookmark", "create", "feature");
    await jj("new", "-m", "Next change");
    return { path, jj, cleanup: () => rm(path, { recursive: true, force: true }) };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}
