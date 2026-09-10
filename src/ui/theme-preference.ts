import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseThemeName, type ThemeName } from "./theme";

export function themePreferencePath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jj-evolved", "theme");
}

export async function readThemePreference(path = themePreferencePath()): Promise<ThemeName> {
  try {
    return parseThemeName((await readFile(path, "utf8")).trim());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "terminal";
    throw error;
  }
}

export async function saveThemePreference(theme: ThemeName, path = themePreferencePath()) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${theme}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
