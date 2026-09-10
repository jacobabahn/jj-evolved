import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../../src/app";
import { Repository } from "../../src/repository/repository";
import { fixture } from "../fixture";

const baseline = `first=old\n${"context\n".repeat(20)}last=old\n`;
const selected = baseline.replace("first=old", "first=selected");
const complete = selected.replace("last=old", "last=remaining");

async function setup() {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "jj-evolved-editors-"));
  const mode = join(directory, "mode");
  const calls = join(directory, "calls");
  const editor = join(directory, "editor.js");
  try {
    await Bun.write(mode, "select");
    await Bun.write(editor, `
      const fs = require("node:fs");
      const path = require("node:path");
      const [modeFile, callsFile, left, right] = process.argv.slice(2);
      fs.appendFileSync(callsFile, right ? "diff\\n" : "description\\n");
      if (!right) process.exit(0);
      const mode = fs.readFileSync(modeFile, "utf8");
      if (mode === "fail") process.exit(1);
      const content = fs.readFileSync(path.join(left, "hello.txt"), "utf8");
      fs.writeFileSync(path.join(right, "hello.txt"), mode === "none" ? content : content.replace("first=old", "first=selected"));
    `);
    await f.jj("config", "set", "--repo", "ui.diff-editor", "selection-test");
    await f.jj("config", "set", "--repo", "merge-tools.selection-test.program", process.execPath);
    await f.jj("config", "set", "--repo", "merge-tools.selection-test.edit-args", JSON.stringify([editor, mode, calls, "$left", "$right"]));
    await f.jj("config", "set", "--repo", "ui.editor", JSON.stringify([process.execPath, editor, mode, calls]));
    await f.jj("edit", "feature");
    await Bun.write(join(f.path, "hello.txt"), baseline);
    await f.jj("new", "-m", "Interactive edits");
    await Bun.write(join(f.path, "hello.txt"), complete);
    const repo = await Repository.open(f.path);
    const source = (await repo.snapshot("@")).revisions[0];
    const destination = (await repo.snapshot("feature")).revisions[0];
    if (!source || !destination) throw new Error("Missing test changes");
    return { ...f, repo, source, destination, mode, calls,
      cleanup: async () => { await f.cleanup(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await f.cleanup(); await rm(directory, { recursive: true, force: true }); throw error; }
}

for (const kind of ["squash", "split"] satisfies ("squash" | "split")[]) {
  test(`interactive ${kind} opens the configured editor, moves only selected hunks and returns to the app`, async () => {
    const f = await setup();
    const screen = await createTestRenderer({ width: 110, height: 32 });
    const app = createApp(screen.renderer, f.repo);
    async function until(predicate: () => boolean | Promise<boolean>) {
      for (let attempt = 0; attempt < 400; attempt++) {
        await screen.renderOnce();
        if (await predicate()) return;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for the editor: ${screen.captureCharFrame()}`);
    }
    try {
      await app.start();
      screen.mockInput.pressKey(" ");
      const choices = screen.renderer.root.findDescendantById("action-choices");
      if (!(choices instanceof SelectRenderable)) throw new Error("Missing action menu");
      choices.setSelectedIndex(choices.options.findIndex(option => option.name === `${kind === "split" ? "Split" : "Squash"} interactively`));
      screen.mockInput.pressEnter();
      if (kind === "squash") {
        await until(() => choices.options.some(option => option.name.startsWith(f.destination.changeId.slice(0, 8))));
        choices.setSelectedIndex(choices.options.findIndex(option => option.name.startsWith(f.destination.changeId.slice(0, 8))));
        screen.mockInput.pressEnter();
      }
      await until(async () => {
        await Bun.sleep(10);
        return (await Bun.file(f.calls).exists()) && screen.captureCharFrame().includes("Ready.") && !screen.captureCharFrame().includes("Opening JJ");
      });
      expect(await Bun.file(f.calls).text()).toContain("diff");
      if (kind === "split") expect(await Bun.file(f.calls).text()).toContain("description");
      expect(await Bun.file(join(f.path, "hello.txt")).text()).toBe(complete);
      const snapshot = await f.repo.snapshot("all()");
      const retained = snapshot.revisions.find(revision => revision.changeId === f.source.changeId);
      if (!retained) throw new Error("Source identity was lost");
      const first = kind === "squash" ? "feature" : retained.commitId;
      expect(await f.jj("file", "show", "-r", first, "hello.txt")).toBe(selected);
      screen.mockInput.pressKey("?");
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("Keyboard reference");
    } finally { app.stop(); screen.renderer.destroy(); await f.cleanup(); }
  }, 15_000);
}

test("interactive commands reject stale source revisions before opening an editor", async () => {
  const f = await setup();
  try {
    await f.jj("describe", "-m", "Changed externally");
    await expect(f.repo.interactive({ kind: "split", revision: f.source })).rejects.toThrow("selected revision has changed");
    expect(await Bun.file(f.calls).exists()).toBe(false);
  } finally { await f.cleanup(); }
});

for (const mode of ["none", "fail"]) {
  test(`returning from a ${mode === "none" ? "no-selection" : "failed"} editor preserves file contents and restores keyboard input`, async () => {
    const f = await setup();
    const screen = await createTestRenderer({ width: 110, height: 32 });
    const app = createApp(screen.renderer, f.repo);
    try {
      await Bun.write(f.mode, mode);
      await app.start();
      const operation = await f.repo.operationId();
      screen.mockInput.pressKey(" ");
      const choices = screen.renderer.root.findDescendantById("action-choices");
      if (!(choices instanceof SelectRenderable)) throw new Error("Missing actions");
      choices.setSelectedIndex(choices.options.findIndex(option => option.name === "Split interactively"));
      screen.mockInput.pressEnter();
      let returned = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        await screen.renderOnce();
        if (await Bun.file(f.calls).exists() && screen.captureCharFrame().includes(mode === "none" ? "Ready." : "did not complete")) {
          returned = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(returned).toBe(true);
      if (mode === "fail") expect(await f.repo.operationId()).toBe(operation);
      else {
        const original = (await f.repo.snapshot(f.source.changeId)).revisions[0];
        if (!original) throw new Error("Missing original split change");
        expect(await f.repo.files(original)).toEqual([]);
      }
      expect(await Bun.file(join(f.path, "hello.txt")).text()).toBe(complete);
      screen.mockInput.pressKey("?");
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("Keyboard reference");
    } finally { app.stop(); screen.renderer.destroy(); await f.cleanup(); }
  }, 15_000);
}
