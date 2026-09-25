import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../../src/app";
import { Repository } from "../../src/repository/repository";
import { fixture } from "../fixture";

for (const kind of ["describe", "resolve"] as const) {
  for (const outcome of ["save", "cancel", "fail"] as const) {
    test(`${kind} editor ${outcome} returns to the app with current repository data`, async () => {
      const f = await fixture();
      const directory = await mkdtemp(join(tmpdir(), "jj-evolved-editor-test-"));
      const calls = join(directory, "calls");
      const editor = join(directory, "editor.cjs");
      const screen = await createTestRenderer({ width: 120, height: 32 });
      let app: ReturnType<typeof createApp> | undefined;
      try {
        await Bun.write(editor, `
          const fs = require('node:fs');
          const file = process.argv[2];
          fs.writeFileSync(${JSON.stringify(calls)}, fs.readFileSync(file));
          if (${JSON.stringify(outcome)} === 'fail') process.exit(1);
          if (${JSON.stringify(outcome)} === 'save') fs.writeFileSync(file, ${JSON.stringify(kind === "describe" ? "Edited title\n\nMultiline body\n" : "resolved content\n")});
        `);
        if (kind === "describe") {
          await f.jj("describe", "-r", "feature", "-m", "Original title\n\nOriginal body");
          await f.jj("config", "set", "--repo", "ui.editor", JSON.stringify([process.execPath, editor]));
        } else {
          await f.jj("new", "feature", "-m", "Left");
          await Bun.write(join(f.path, "hello.txt"), "left\n");
          await f.jj("bookmark", "create", "left");
          await f.jj("new", "feature", "-m", "Right");
          await Bun.write(join(f.path, "hello.txt"), "right\n");
          await f.jj("new", "left", "@", "-m", "Conflicted merge");
          await f.jj("bookmark", "create", "merge");
          await f.jj("new", "feature", "-m", "Unrelated working copy");
          await f.jj("config", "set", "--repo", "ui.merge-editor", "test-editor");
          await f.jj("config", "set", "--repo", "merge-tools.test-editor.program", process.execPath);
          await f.jj("config", "set", "--repo", "merge-tools.test-editor.merge-args", JSON.stringify([editor, "$output"]));
        }
        const repo = await Repository.open(f.path);
        const target = (await repo.snapshot(kind === "describe" ? "feature" : "merge")).revisions[0]!;
        const workingCopy = (await repo.snapshot("@")).revisions[0]!.changeId;
        app = createApp(screen.renderer, repo);
        await app.start();
        // Use a filtered view of a non-working-copy revision to verify it stays selected.
        screen.mockInput.pressKey("L");
        screen.mockInput.pressKey("a", { ctrl: true });
        screen.mockInput.pressKey("k", { ctrl: true });
        await screen.mockInput.typeText(target.changeId);
        screen.mockInput.pressEnter();
        async function until(predicate: () => boolean | Promise<boolean>) {
          for (let i = 0; i < 400; i++) {
            await screen.renderOnce();
            if (await predicate()) return;
            await Bun.sleep(10);
          }
          throw new Error(screen.captureCharFrame());
        }
        await until(() => screen.captureCharFrame().includes("Ready."));
        {
          screen.mockInput.pressKey(" ");
          const choices = screen.renderer.root.findDescendantById("action-choices") as SelectRenderable;
          const index = choices.options.findIndex(option => option.name === (kind === "describe" ? "Edit description in editor" : "Resolve conflicts"));
          expect(index).toBeGreaterThanOrEqual(0);
          choices.setSelectedIndex(index);
          screen.mockInput.pressEnter();
        }
        await until(async () => await Bun.file(calls).exists() && screen.captureCharFrame().includes(outcome === "fail" || (kind === "resolve" && outcome === "cancel") ? "did not complete" : "Ready."));
        const updated = (await repo.snapshot(target.changeId)).revisions[0]!;
        expect((await repo.snapshot("@")).revisions[0]!.changeId).toBe(workingCopy);
        expect(screen.captureCharFrame()).toContain(`revset: ${target.changeId}`);
        if (kind === "describe") {
          expect(await Bun.file(calls).text()).toContain("Original body");
          expect(updated.description).toBe(outcome === "save" ? "Edited title\n\nMultiline body\n" : target.description);
          expect(screen.captureCharFrame()).toContain(outcome === "save" ? "Edited title" : "Original title");
        } else {
          expect(updated.conflict).toBe(outcome !== "save");
          if (outcome === "save") expect(await f.jj("file", "show", "-r", target.changeId, "hello.txt")).toBe("resolved content\n");
        }
        screen.mockInput.pressKey("?");
        await screen.renderOnce();
        expect(screen.captureCharFrame()).toContain("Keyboard reference");
      } finally {
        app?.stop();
        screen.renderer.destroy();
        await f.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    }, 15_000);
  }
}

for (const kind of ["describe", "resolve"] as const) {
  test(`${kind} rejects a stale revision before opening an editor`, async () => {
    const f = await fixture();
    try {
      const repo = await Repository.open(f.path);
      const revision = (await repo.snapshot("@")).revisions[0]!;
      await f.jj("describe", "-m", "Changed externally");
      await expect(repo.interactive({ kind, revision })).rejects.toThrow("selected revision has changed");
    } finally { await f.cleanup(); }
  });
}
