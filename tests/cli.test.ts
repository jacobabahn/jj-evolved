import { expect, test } from "bun:test";
import { join } from "node:path";

async function cli(args: string[], env = process.env) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), ...args], {
    env, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("help works without jj and missing jj fails before entering the terminal", async () => {
  const env = { ...process.env, PATH: "/nonexistent" };
  const help = await cli(["--help"], env);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Usage:");
  const missing = await cli([], env);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("jj is not installed");
  expect(missing.stdout).toBe("");
});
