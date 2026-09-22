import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { fixture } from "./fixture";

/** A real child editor configured through JJ, kept outside the working copy. */
export async function descriptionEditor(f: Awaited<ReturnType<typeof fixture>>, description: string) {
  const directory = await mkdtemp(join(tmpdir(), "jj-description-editor-"));
  const script = join(directory, "editor.cjs");
  const mode = join(directory, "mode");
  const original = join(directory, "original");
  try {
    await Bun.write(mode, "save");
    await Bun.write(script, `
      const fs = require("node:fs");
      const file = process.argv.at(-1);
      fs.writeFileSync(${JSON.stringify(original)}, fs.readFileSync(file));
      const mode = fs.readFileSync(${JSON.stringify(mode)}, "utf8");
      if (mode !== "unchanged") fs.writeFileSync(file, ${JSON.stringify(description)});
      if (mode === "fail") process.exit(1);
    `);
    await f.jj("config", "set", "--repo", "ui.editor", JSON.stringify([process.execPath, script]));
    return { mode, original, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
