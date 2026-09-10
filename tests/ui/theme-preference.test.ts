import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readThemePreference, saveThemePreference } from "../../src/ui/theme-preference";

test("preferences default to terminal and survive saves without leftover temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jj-theme-"));
  const path = join(directory, "config", "theme");
  try {
    expect(await readThemePreference(path)).toBe("terminal");
    await saveThemePreference("gruvbox", path);
    expect(await readThemePreference(path)).toBe("gruvbox");
    await saveThemePreference("terminal", path);
    expect(await readThemePreference(path)).toBe("terminal");
    expect(await readdir(join(directory, "config"))).toEqual(["theme"]);
    await writeFile(path, "invalid");
    await expect(readThemePreference(path)).rejects.toThrow("Unknown theme");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
