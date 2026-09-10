import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../../src/app";
import { Repository } from "../../src/repository/repository";
import { fixture } from "../fixture";

for (const code of [0, 1]) {
  test(`Open in Hunk passes the selected commit and restores the app after exit ${code}`, async () => {
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), "jj-evolved-hunk-"));
    const originalPath = process.env.PATH;
    const screen = await createTestRenderer({ width: 120, height: 32 });
    const repo = await Repository.open(f.path);
    const app = createApp(screen.renderer, repo);
    try {
      const calls = join(directory, "calls.json");
      const executable = join(directory, "hunk");
      await Bun.write(executable, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(${code});\n`);
      await chmod(executable, 0o755);
      process.env.PATH = `${directory}:${originalPath ?? ""}`;
      await app.start();
      const revision = (await repo.snapshot("@")).revisions[0];
      if (!revision) throw new Error("Missing working copy");
      screen.mockInput.pressKey(" ");
      const choices = screen.renderer.root.findDescendantById("action-choices");
      if (!(choices instanceof SelectRenderable)) throw new Error("Missing action menu");
      choices.setSelectedIndex(choices.options.findIndex(option => option.name === "Open in Hunk"));
      screen.mockInput.pressEnter();
      let returned = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        await screen.renderOnce();
        if (await Bun.file(calls).exists() && screen.captureCharFrame().includes(code === 0 ? "Ready." : "Hunk exited with code 1")) {
          returned = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(returned).toBe(true);
      expect(await Bun.file(calls).json()).toEqual({ args: ["show", revision.commitId], cwd: await f.jj("root").then(root => root.trim()) });
      screen.mockInput.pressKey("?");
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("Keyboard reference");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      app.stop();
      screen.renderer.destroy();
      await f.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}

test("missing Hunk reports installation instructions", async () => {
  const f = await fixture();
  const originalPath = process.env.PATH;
  try {
    const repo = await Repository.open(f.path);
    const revision = (await repo.snapshot("@")).revisions[0];
    if (!revision) throw new Error("Missing working copy");
    process.env.PATH = "";
    await expect(repo.openHunk(revision)).rejects.toThrow("npm install -g hunkdiff");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await f.cleanup();
  }
});
