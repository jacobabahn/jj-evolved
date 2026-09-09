import { readThemePreference, saveThemePreference } from "./theme-preference";
import { parseArgs } from "node:util";
import { parseThemeName, themes, themeNames } from "./theme";
import { createCliRenderer } from "@opentui/core";
import { createApp } from "./app";
import { Repository } from "./repository";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`Usage: bun start [--theme NAME] [repository-path]\n\nA keyboard-driven Jujutsu workspace. Requires jj on PATH.\nThemes: ${themeNames.join(", ")}.\nTheme defaults to JJ_EVOLVED_THEME, saved preference, or terminal.\nPress t to change themes or ? for keyboard help.\n`);
} else {
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true, options: { theme: { type: "string" } },
    });
    if (positionals.length > 1) throw new Error("Expected at most one repository path.");
    const theme = themes[parseThemeName(values.theme ?? process.env.JJ_EVOLVED_THEME ?? await readThemePreference())];
    const repository = await Repository.open(positionals[0] ?? process.cwd());
    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    try {
      const app = createApp(renderer, repository, theme, saveThemePreference);
      await app.start();
    } catch (error) {
      renderer.destroy();
      throw error;
    }
  } catch (error) {
    process.stderr.write(`jj-evolved: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
