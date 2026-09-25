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

test("themes validate before opening a repository and CLI overrides the environment", async () => {
  const env = { ...process.env, PATH: "/nonexistent", JJ_EVOLVED_THEME: "invalid" };
  for (const args of [[], ["--theme", "invalid"], ["--theme=invalid"]]) {
    const result = await cli(args, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown theme");
    expect(result.stdout).toBe("");
  }
  for (const theme of ["terminal", "dark", "light"]) {
    const result = await cli(["--theme", theme], env);
    expect(result.stderr).toContain("jj is not installed");
    expect(result.stderr).not.toContain("Unknown theme");
  }
  expect((await cli(["--theme"], env)).code).toBe(1);
  expect((await cli(["--help"], env)).stdout).toContain("--theme");
});

test("startup reads the saved theme and explicit choices override it", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "jj-cli-theme-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "/nonexistent", XDG_CONFIG_HOME: directory };
  delete env.JJ_EVOLVED_THEME;
  try {
    await mkdir(join(directory, "jj-evolved"));
    await writeFile(join(directory, "jj-evolved", "theme"), "broken-theme");
    expect((await cli([], env)).stderr).toContain('Unknown theme "broken-theme"');
    expect((await cli([], { ...env, JJ_EVOLVED_THEME: "vesper" })).stderr).toContain("jj is not installed");
    expect((await cli(["--theme", "gruvbox"], env)).stderr).toContain("jj is not installed");
    await writeFile(join(directory, "jj-evolved", "theme"), "catppuccin");
    expect((await cli([], env)).stderr).toContain("jj is not installed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("key presets validate before terminal startup and CLI overrides environment", async () => {
  const env = { ...process.env, PATH: "/nonexistent", JJ_EVOLVED_KEYS: "invalid" };
  const invalid = await cli([], env);
  expect(invalid.stderr).toContain('Unknown preset "invalid" from JJ_EVOLVED_KEYS');
  expect(invalid.stderr).toContain("jjui, legacy");
  expect(invalid.stdout).toBe("");
  expect((await cli(["--keys", "invalid"], env)).stderr).toContain("from --keys");
  for (const preset of ["jjui", "legacy"]) {
    expect((await cli(["--keys", preset], env)).stderr).toContain("jj is not installed");
    expect((await cli([], { ...env, JJ_EVOLVED_KEYS: preset })).stderr).toContain("jj is not installed");
  }
  expect((await cli(["--keys"], env)).code).toBe(1);
  expect((await cli(["--help"], env)).stdout).toContain("--keys PRESET");
});
