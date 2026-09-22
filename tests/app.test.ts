import { expect, spyOn, test } from "bun:test";
import { SelectRenderable, TextRenderable, TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../src/app";
import { Repository } from "../src/repository/repository";
import { fixture } from "./fixture";

async function setup(kittyKeyboard = false) {
  const f = await fixture();
  const screen = await createTestRenderer({ width: 100, height: 30, kittyKeyboard });
  const repo = await Repository.open(f.path);
  const app = createApp(screen.renderer, repo);
  await app.start();
  async function until(text: string) {
    for (let attempt = 0; attempt < 150; attempt++) {
      await screen.renderOnce();
      const frame = screen.captureCharFrame();
      if (frame.includes(text)) return frame;
      await Bun.sleep(10);
    }
    throw new Error(`Expected screen to contain ${text}:\n${screen.captureCharFrame()}`);
  }
  async function prompt(value: string) {
    screen.mockInput.pressKey("a", { ctrl: true });
    screen.mockInput.pressKey("k", { ctrl: true });
    await screen.mockInput.typeText(value);
    screen.mockInput.pressEnter();
    await until("Ready.");
  }
  function choose(name: string) {
    const chooser = screen.renderer.root.findDescendantById("action-choices");
    if (!(chooser instanceof SelectRenderable)) throw new Error("Missing action picker");
    for (let index = 0; index < chooser.options.length; index++) {
      if (chooser.getSelectedOption()?.name === name) { screen.mockInput.pressEnter(); return; }
      screen.mockInput.pressKey("j");
    }
    throw new Error(`Missing choice: ${name}`);
  }
  return { f, screen, repo, app, until, prompt, choose, cleanup: async () => { app.stop(); screen.renderer.destroy(); await f.cleanup(); } };
}

test("absorb menu preview cancels, rejects stale state, refreshes and applies", async () => {
  const t = await setup();
  try {
    await Bun.write(`${t.f.path}/hello.txt`, "absorbed through the UI\n");
    await Bun.write(`${t.f.path}/leftover.txt`, "keep this edit\n");
    t.screen.mockInput.pressKey("r");
    await t.until("+ absorbed through the UI");
    const operation = await t.repo.operationId();
    t.screen.mockInput.pressKey(" ");
    t.choose("Absorb into ancestors");
    await t.until("Absorb from");
    expect(await t.repo.operationId()).toBe(operation);
    let sawRemainder = false;
    for (let page = 0; page < 20; page++) {
      await t.screen.waitForVisualIdle();
      if (t.screen.captureCharFrame().includes("Remaining in source:")) { sawRemainder = true; break; }
      t.screen.mockInput.pressKey("\x1b[6~");
    }
    expect(sawRemainder).toBe(true);
    t.screen.mockInput.pressEscape();
    await t.until("Change preview");
    expect(await t.repo.operationId()).toBe(operation);
    t.screen.mockInput.pressKey("a");
    await t.until("Absorb from");
    await t.f.jj("bookmark", "create", "external");
    t.screen.mockInput.pressEnter();
    await t.until("Repository changed since this preview");
    t.screen.mockInput.pressKey("p");
    await t.until("Ready.");
    t.screen.mockInput.pressEnter();
    await t.until("absorb completed");
    expect(await t.f.jj("file", "show", "-r", "feature", "hello.txt")).toBe("absorbed through the UI\n");
    const current = (await t.repo.snapshot("@")).revisions[0];
    if (!current) throw new Error("Missing working copy");
    expect(await t.repo.diff(current)).toContain("+keep this edit");
  } finally { await t.cleanup(); }
}, 15_000);

test("absorb follows the working copy when an unnamed filtered source disappears", async () => {
  const t = await setup();
  try {
    await t.f.jj("describe", "-m", "");
    await Bun.write(`${t.f.path}/hello.txt`, "all absorbed\n");
    t.screen.mockInput.pressKey("/");
    await t.prompt("@");
    t.screen.resize(80, 24);
    t.screen.mockInput.pressKey("a");
    await t.until("Absorb from");
    t.screen.mockInput.pressEnter();
    await t.until("absorb completed");
    const current = (await t.repo.snapshot("@")).revisions[0];
    if (!current) throw new Error("Missing working copy");
    await t.until(current.changeId.slice(0, 8));
    expect(t.screen.captureCharFrame()).toContain("revset: all()");
    expect(await t.repo.diff(current)).toBe("");
  } finally { await t.cleanup(); }
}, 15_000);

test("evolution menu and shortcut browse description patches without changing repository state", async () => {
  const t = await setup();
  try {
    await t.f.jj("describe", "-m", "Evolution rename");
    t.screen.mockInput.pressKey("r");
    await t.until("Evolution rename");
    await t.until("Ready.");
    const operation = await t.repo.operationId();
    t.screen.mockInput.pressKey(" ");
    t.choose("Change evolution");
    await t.until("Changes introduced in this version:");
    await t.screen.waitForVisualIdle();
    t.screen.mockInput.pressKey("\x1b[6~");
    await t.until("+ Evolution rename");
    t.screen.mockInput.pressKey("j");
    await t.until("new empty commit");
    expect(await t.repo.operationId()).toBe(operation);
    t.screen.mockInput.pressEscape();
    await t.until("Change preview");
    t.screen.resize(80, 24);
    t.screen.mockInput.pressKey("v");
    await t.until("Change evolution");
    expect(t.screen.captureCharFrame()).toContain("Esc close");
    t.screen.mockInput.pressEscape();
    expect(await t.repo.operationId()).toBe(operation);
  } finally { await t.cleanup(); }
}, 15_000);

for (const close of [false, true]) test(`late evolution previews are ignored, overlay closed=${close}`, async () => {
  const t = await setup();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = t.repo.evolutionDiff.bind(t.repo);
  let blockedCommit = "";
  t.repo.evolutionDiff = async (operation, entry) => {
    if (entry.commitId === blockedCommit) {
      started.resolve();
      await gate.promise;
      return "OUTDATED EVOLUTION PREVIEW";
    }
    return original(operation, entry);
  };
  try {
    await t.f.jj("describe", "-m", "Newest evolution version");
    t.screen.mockInput.pressKey("r");
    await t.until("Newest evolution version");
    await t.until("Ready.");
    const current = (await t.repo.snapshot("@")).revisions[0];
    if (!current) throw new Error("Missing working copy");
    blockedCommit = current.commitId;
    t.screen.mockInput.pressKey("v");
    await started.promise;
    await t.until("Ready.");
    t.screen.mockInput.pressKey("j");
    await t.until("Selection preview");
    if (close) t.screen.mockInput.pressEscape();
    gate.resolve();
    await t.until(close ? "Change preview" : "Selection preview");
    await t.screen.waitForVisualIdle();
    expect(t.screen.captureCharFrame()).not.toContain("OUTDATED EVOLUTION PREVIEW");
    if (close) expect(t.screen.captureCharFrame()).not.toContain("Change evolution");
  } finally { gate.resolve(); await t.cleanup(); }
}, 15_000);

test("evolution loads older versions through the picker after an external rewrite", async () => {
  const t = await setup();
  try {
    for (let version = 0; version < 51; version++) await t.f.jj("describe", "-m", `History version ${version}`);
    t.screen.mockInput.pressKey("r");
    await t.until("History version 50");
    await t.until("Ready.");
    t.screen.mockInput.pressKey("v");
    await t.until("Change evolution");
    await t.until("Ready.");
    await t.f.jj("describe", "-m", "Later external version");
    const operation = await t.repo.operationId();
    t.choose("Load older versions");
    await t.until("Ready.");
    const chooser = t.screen.renderer.root.findDescendantById("action-choices");
    if (!(chooser instanceof SelectRenderable)) throw new Error("Missing version picker");
    expect(chooser.options).toHaveLength(52);
    expect(chooser.getSelectedOption()?.name).toContain("History version 0");
    expect(chooser.options.some(option => option.name.includes("Later external version"))).toBe(false);
    expect(chooser.options.some(option => option.name === "Load older versions")).toBe(false);
    expect(await t.repo.operationId()).toBe(operation);
  } finally { await t.cleanup(); }
}, 15_000);

test("keyboard browsing, status, help, revsets and empty state at 80x24", async () => {
  const t = await setup();
  try {
    await t.until("Empty change.");
    t.screen.mockInput.pressKey("j");
    await t.until("+ hello from jj-evolved");
    t.screen.mockInput.pressKey("s");
    await t.until("Working-copy status");
    await t.until("Working copy");
    t.screen.mockInput.pressKey("?");
    await t.until("Keyboard reference");
    t.screen.mockInput.pressKey("/");
    await t.until("Esc cancel");
    t.screen.mockInput.pressEscape();
    await Bun.sleep(50);
    await t.screen.renderOnce();
    expect(t.screen.captureCharFrame()).not.toContain("Esc cancel");
    t.screen.mockInput.pressKey("/");
    await t.prompt("none()");
    await t.until("No revisions match");
    t.screen.mockInput.pressKey("/");
    await t.prompt("");
    await t.until("3 revisions");
    t.screen.resize(80, 24);
    await t.screen.renderOnce();
    const frame = t.screen.captureCharFrame();
    expect(frame).toContain("jj-evolved");
    expect(frame).toContain("Revisions");
    expect(frame).toContain("q quit");
    expect(frame).toContain("┬");
    expect(frame).toContain("┴");
    expect(frame).not.toContain("┐┌");
    expect(frame).not.toContain("┘└");
  } finally { await t.cleanup(); }
}, 15_000);

test("keyboard describe, cancelled new, confirmed new and external refresh", async () => {
  const t = await setup();
  try {
    t.screen.mockInput.pressKey("d");
    await t.until("Describe");
    await t.prompt("Renamed in the TUI");
    expect((await t.repo.snapshot("@")).revisions[0]?.description.trim()).toBe("Renamed in the TUI");
    t.screen.mockInput.pressKey("n");
    await t.until("Create child");
    t.screen.mockInput.pressEscape();
    await Bun.sleep(50);
    expect((await t.repo.snapshot("all()")).revisions).toHaveLength(3);
    t.screen.mockInput.pressKey("n");
    t.screen.mockInput.pressEnter();
    t.screen.mockInput.pressKey("n");
    t.screen.mockInput.pressEnter();
    await t.until("4 revisions");
    await t.until("Ready.");
    expect((await t.repo.snapshot("all()")).revisions).toHaveLength(4);
    expect((await t.repo.snapshot("@")).revisions[0]?.description.trim()).toBe("");
    await t.f.jj("describe", "-m", "External edit");
    t.screen.mockInput.pressKey("r");
    await t.until("External edit");
  } finally { await t.cleanup(); }
}, 15_000);

test("action menu edits the selected description and switches the working copy", async () => {
  const t = await setup();
  try {
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressKey(" ");
    t.choose("Describe change");
    await t.until("Describe");
    await t.prompt("Edited parent description");
    expect((await t.repo.snapshot("feature")).revisions[0]?.description.trim()).toBe("Edited parent description");
    expect((await t.repo.snapshot("@")).revisions[0]?.description.trim()).toBe("Next change");
    t.screen.mockInput.pressKey(" ");
    t.choose("Edit change");
    await t.until("Confirm operation");
    t.screen.mockInput.pressEnter();
    await t.until("Ready.");
    expect((await t.repo.snapshot("@")).revisions[0]?.description.trim()).toBe("Edited parent description");
  } finally { await t.cleanup(); }
}, 15_000);

test("e switches the working copy immediately without a confirmation prompt", async () => {
  const t = await setup();
  try {
    const target = (await t.repo.snapshot("feature")).revisions[0]?.changeId;
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressKey("e");
    await t.until("edit completed");
    expect((await t.repo.snapshot("@")).revisions[0]?.changeId).toBe(target);
    expect(t.screen.captureCharFrame()).not.toContain("Confirm operation");
  } finally { await t.cleanup(); }
}, 15_000);

test("invalid revset preserves history and cancelling description preserves multiline text", async () => {
  const t = await setup();
  try {
    t.screen.mockInput.pressKey("/");
    t.screen.mockInput.pressKey("a", { ctrl: true });
    t.screen.mockInput.pressKey("k", { ctrl: true });
    await t.screen.mockInput.typeText("invalid(((");
    t.screen.mockInput.pressEnter();
    await t.until("Error");
    expect(t.screen.captureCharFrame()).toContain("revset: all()");
    expect(t.screen.captureCharFrame()).toContain("Next change");
    t.screen.mockInput.pressEscape();
    await Bun.sleep(50);
    await t.f.jj("describe", "-m", "First line\nSecond line");
    t.screen.mockInput.pressKey("r");
    await t.until("Ready.");
    t.screen.mockInput.pressKey("d");
    await t.until("Shift/Alt+Enter newline");
    expect((t.screen.renderer.root.findDescendantById("description-input") as TextareaRenderable).plainText).toBe("First line\nSecond line");
    t.screen.mockInput.pressEscape();
    expect((await t.repo.snapshot("@")).revisions[0]?.description).toContain("Second line");
  } finally { await t.cleanup(); }
}, 15_000);

test("an older diff cannot replace a newer selection", async () => {
  const f = await fixture();
  const screen = await createTestRenderer({ width: 100, height: 30 });
  const repo = await Repository.open(f.path);
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let first = true;
  const originalDiff = repo.diff.bind(repo);
  const delayed = spyOn(repo, "diff").mockImplementation(async (revision, files) => {
    if (first) {
      first = false;
      started.resolve();
      await gate.promise;
    }
    return originalDiff(revision, files);
  });
  const app = createApp(screen.renderer, repo);
  try {
    const loading = app.start();
    await started.promise;
    screen.mockInput.pressKey("j");
    for (let attempt = 0; attempt < 100; attempt++) {
      await screen.renderOnce();
      if (screen.captureCharFrame().includes("+ hello from jj-evolved")) break;
      await Bun.sleep(10);
    }
    expect(screen.captureCharFrame()).toContain("+ hello from jj-evolved");
    gate.resolve();
    await loading;
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("+ hello from jj-evolved");
  } finally {
    gate.resolve();
    delayed.mockRestore();
    app.stop();
    screen.renderer.destroy();
    await f.cleanup();
  }
}, 15_000);

test("action menu creates and renames a bookmark, then undo recovers the old name", async () => {
  const t = await setup();
  try {
    t.screen.mockInput.pressKey(" ");
    await t.until("Actions");
    t.choose("Create bookmark");
    await t.until("Bookmark name");
    await t.screen.mockInput.typeText("keyboard-bookmark");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    t.screen.mockInput.pressEnter();
    await t.until("Ready.");
    expect((await t.repo.bookmarks()).some(b => b.name === "keyboard-bookmark")).toBe(true);
    t.screen.mockInput.pressKey("b");
    await t.until("Bookmarks");
    await t.until("Ready.");
    t.choose("keyboard-bookmark");
    await t.until("Rename bookmark");
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressEnter();
    await t.until("New bookmark name");
    t.screen.mockInput.pressKey("a", { ctrl: true });
    t.screen.mockInput.pressKey("k", { ctrl: true });
    await t.screen.mockInput.typeText("renamed-in-ui");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    t.screen.mockInput.pressEnter();
    await t.until("Ready.");
    expect((await t.repo.bookmarks()).some(b => b.name === "renamed-in-ui")).toBe(true);
    t.screen.mockInput.pressKey("u");
    await t.until("Confirm undo");
    t.screen.mockInput.pressEnter();
    await t.until("Ready.");
    expect((await t.repo.bookmarks()).some(b => b.name === "keyboard-bookmark")).toBe(true);
    t.screen.mockInput.pressKey("o");
    await t.until("Operation history");
    await t.until("Ready.");
    t.screen.mockInput.pressEnter();
    await t.until("Restore this operation");
    t.screen.mockInput.pressEscape();
    await Bun.sleep(50);
  } finally { await t.cleanup(); }
}, 15_000);

test("stale action confirmation refuses to edit and cancellation keeps the working copy", async () => {
  const t = await setup();
  try {
    const original = (await t.repo.snapshot("@")).revisions[0];
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressKey(" ");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    t.screen.mockInput.pressEscape();
    await Bun.sleep(50);
    expect((await t.repo.snapshot("@")).revisions[0]?.commitId).toBe(original?.commitId);
    t.screen.mockInput.pressKey(" ");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    await t.f.jj("bookmark", "create", "external");
    t.screen.mockInput.pressEnter();
    await t.until("Repository changed");
    expect((await t.repo.snapshot("@")).revisions[0]?.commitId).toBe(original?.commitId);
  } finally { await t.cleanup(); }
}, 15_000);

test("keyboard file selection splits a change and squashes it back", async () => {
  const t = await setup();
  try {
    await Bun.write(`${t.f.path}/one.txt`, "one\n");
    await Bun.write(`${t.f.path}/two.txt`, "two\n");
    t.screen.mockInput.pressKey("r");
    await t.until("Ready.");
    const original = (await t.repo.snapshot("@")).revisions[0];
    if (!original) throw new Error("Missing original");
    t.screen.mockInput.pressKey(" ");
    t.choose("Split change");
    await t.until("Continue with 0 files");
    await t.until("Ready.");
    t.choose("[ ] one.txt");
    t.screen.mockInput.pressKey("k");
    t.choose("Continue with 1 files");
    await t.until("First change description");
    await t.screen.mockInput.typeText("First group");
    t.screen.mockInput.pressEnter();
    await t.until("Keep original description");
    t.choose("Edit second description");
    await t.until("Second change description  [Enter");
    await t.prompt("Second group");
    await t.until("Confirm operation");
    await t.until("Second change: Second group");
    t.screen.mockInput.pressEnter();
    await t.until("Ready.");
    const first = (await t.repo.snapshot(original.changeId)).revisions[0];
    if (!first) throw new Error("Missing first split change");
    expect(first.description.trim()).toBe("First group");
    expect((await t.repo.snapshot(`${first.commitId}+`)).revisions[0]?.description.trim()).toBe("Second group");
    expect((await t.repo.files(first)).map(f => f.path)).toEqual(["one.txt"]);
    t.screen.mockInput.pressKey(" ");
    t.choose("Squash changes");
    await t.until("Destination: Choose a revision");
    t.screen.mockInput.pressEnter();
    await t.until(`${first.changeId.slice(0, 8)} First group`);
    const destinations = t.screen.renderer.root.findDescendantById("history-choices");
    if (!(destinations instanceof SelectRenderable)) throw new Error("Missing destinations");
    for (let i = 0; i < destinations.options.length && destinations.getSelectedOption()?.name !== `${first.changeId.slice(0, 8)} First group`; i++) t.screen.mockInput.pressKey("j");
    expect(destinations.getSelectedOption()?.name).toBe(`${first.changeId.slice(0, 8)} First group`);
    t.screen.mockInput.pressEnter();
    await t.until("Preview ready");
    for (let i = 0; i < 3; i++) t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressEnter();
    await t.until("squash completed");
    const combined = (await t.repo.snapshot(first.changeId)).revisions[0];
    if (!combined) throw new Error("Missing combined revision");
    expect((await t.repo.files(combined)).map(f => f.path).sort()).toEqual(["one.txt", "two.txt"]);
    expect(await t.f.jj("diff", "--from", original.commitId, "--to", combined.commitId, "--git")).toBe("");
  } finally { await t.cleanup(); }
}, 15_000);

test("quick-action overlay keeps the graph visible and a failed name editable", async () => {
  const t = await setup();
  try {
    t.screen.resize(80, 24);
    t.screen.mockInput.pressKey(" ");
    t.choose("Create bookmark");
    await t.until("Bookmark name");
    const overlay = t.screen.renderer.root.findDescendantById("action-overlay");
    const input = t.screen.renderer.root.findDescendantById("prompt-input");
    const graph = t.screen.renderer.root.findDescendantById("revisions");
    if (!overlay || !input || !graph) throw new Error("Missing overlay layout");
    expect(overlay.visible).toBe(true);
    expect(graph.visible).toBe(true);
    expect(input.y).toBeGreaterThan(overlay.y);
    expect(input.y + input.height).toBeLessThan(overlay.y + overlay.height);
    await t.screen.mockInput.typeText("feature");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    t.screen.mockInput.pressEnter();
    await t.until("already exists");
    expect(overlay.visible).toBe(true);
    expect(input.visible).toBe(true);
    t.screen.mockInput.pressKey("a", { ctrl: true });
    t.screen.mockInput.pressKey("k", { ctrl: true });
    await t.screen.mockInput.typeText("fixed-name");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    t.screen.mockInput.pressEnter();
    await t.until("completed");
    expect(overlay.visible).toBe(false);
    expect((await t.repo.bookmarks()).some(b => b.name === "fixed-name")).toBe(true);
  } finally { await t.cleanup(); }
}, 15_000);

test("rebase form retains fields on stale failure and requires a reviewed preview", async () => {
  const t = await setup();
  try {
    const source = (await t.repo.snapshot("@")).revisions[0];
    if (!source) throw new Error("Missing source");
    t.screen.mockInput.pressKey(" ");
    t.choose("Rebase change");
    await t.until("Destination: Choose a revision");
    t.screen.mockInput.pressEnter();
    await t.until("j/k choose");
    const choices = t.screen.renderer.root.findDescendantById("history-choices");
    if (!(choices instanceof SelectRenderable)) throw new Error("Missing destinations");
    for (let i = 0; i < choices.options.length - 1; i++) t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressEnter();
    await t.until("Preview ready");
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressEnter();
    await t.until("Preview ready");
    const fields = t.screen.renderer.root.findDescendantById("history-fields");
    if (!(fields instanceof SelectRenderable)) throw new Error("Missing form fields");
    expect(fields.options[0]?.name).toContain("zzzzzzzz");
    expect(fields.options[1]?.name).toContain("Change and descendants");
    await t.f.jj("bookmark", "create", "external-operation");
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressEnter();
    await t.until("Repository changed");
    expect(fields.options[0]?.name).toContain("zzzzzzzz");
    expect(fields.options[1]?.name).toContain("Change and descendants");
    expect((await t.repo.snapshot(source.changeId)).revisions[0]?.parents).toEqual(source.parents);
    t.screen.mockInput.pressKey("p");
    await t.until("Preview ready");
    t.screen.mockInput.pressEnter();
    await t.until("rebase completed");
    expect((await t.repo.snapshot(source.changeId)).revisions[0]?.parents).toEqual(["0".repeat(40)]);
    expect(t.screen.renderer.root.findDescendantById("history-form")).toBeUndefined();
  } finally { await t.cleanup(); }
}, 15_000);

test("inline squash reviews a graph destination before applying", async () => {
  const t = await setup();
  try {
    await Bun.write(`${t.f.path}/inline.txt`, "inline squash\n");
    t.screen.mockInput.pressKey("r");
    await t.until("Ready.");
    const before = await t.repo.operationId();
    t.screen.resize(80, 24);
    t.screen.mockInput.pressKey("S");
    await t.until("Squash from ●");
    t.screen.mockInput.pressEnter();
    await t.until("Choose a different destination");
    expect(await t.repo.operationId()).toBe(before);
    t.screen.mockInput.pressKey("j");
    await t.until("Keep destination description");
    expect(t.screen.captureCharFrame()).toContain("Revisions");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    await t.until("Current tree");
    await t.until("After squash");
    const treeText = t.screen.renderer.root.findDescendantById("confirmation-trees-after");
    const beforeText = t.screen.renderer.root.findDescendantById("confirmation-trees-before");
    if (!treeText || !beforeText) throw new Error("Missing confirmation trees");
    expect(treeText.x).toBeLessThan(beforeText.x);
    expect(beforeText.y).toBe(treeText.y);
    const afterColumn = t.screen.renderer.root.findDescendantById("confirmation-trees-after-column");
    if (!afterColumn) throw new Error("Missing tree border");
    expect(t.screen.captureCharFrame().split("\n")[afterColumn.y]?.[afterColumn.x + afterColumn.width - 1]).toBe("┬");
    const treeFrame = t.screen.captureCharFrame().split("\n");
    for (let y = afterColumn.y + 1; y < afterColumn.y + afterColumn.height - 1; y++) {
      expect(treeFrame[y]?.[afterColumn.x + afterColumn.width - 1]).toBe("│");
    }
    t.screen.resize(120, 30);
    await t.screen.renderOnce();
    expect(treeText.x).toBeLessThan(beforeText.x);
    expect(beforeText.y).toBe(treeText.y);
    expect(await t.repo.operationId()).toBe(before);
    t.screen.mockInput.pressEscape();
    await t.until("Enter preview");
    expect(t.screen.captureCharFrame()).toContain("Squash from ●");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    await t.until("Current tree");
    await t.until("After squash");
    t.screen.mockInput.pressEnter();
    await t.until("squash completed");
    const target = (await t.repo.snapshot("feature")).revisions[0];
    if (!target) throw new Error("Missing squash destination");
    expect(target.description.trim()).toBe("Initial feature");
    expect((await t.repo.files(target)).map(file => file.path)).toContain("inline.txt");
    expect(t.screen.captureCharFrame()).not.toContain("Squash from ●");
    expect(t.screen.captureCharFrame()).not.toContain("Confirm operation");
  } finally { await t.cleanup(); }
}, 15_000);

test("rebase scope marks branches and merges, updates on toggle, and reports filtered descendants", async () => {
  const t = await setup();
  try {
    const source = (await t.repo.snapshot("@")).revisions[0];
    if (!source) throw new Error("Missing source");
    await t.f.jj("new", "-m", "Left descendant");
    const left = (await t.repo.snapshot("@")).revisions[0];
    await t.f.jj("new", source.commitId, "-m", "Right descendant");
    const right = (await t.repo.snapshot("@")).revisions[0];
    if (!left || !right) throw new Error("Missing branches");
    await t.f.jj("new", left.commitId, right.commitId, "-m", "Merged descendant");
    const merge = (await t.repo.snapshot("@")).revisions[0];
    await t.f.jj("new", "root()", "-m", "Unrelated destination");
    const destination = (await t.repo.snapshot("@")).revisions[0];
    if (!merge || !destination) throw new Error("Missing merge or destination");
    t.screen.mockInput.pressKey("r");
    await t.until("Ready.");
    const snapshot = await t.repo.snapshot("all()");
    const marked = (commitId: string) => {
      const index = snapshot.graph.findIndex(row => row.kind === "revision" && row.revision.commitId === commitId);
      const label = t.screen.renderer.root.findDescendantById(`revision-label-${index}`);
      if (!(label instanceof TextRenderable)) throw new Error("Missing revision label");
      return label.content.chunks.map(chunk => chunk.text).join("").startsWith("● ");
    };
    const before = await t.repo.operationId();
    t.screen.mockInput.pressKey("R");
    await t.until("Selected change only");
    expect(marked(source.commitId)).toBe(true);
    expect(marked(left.commitId)).toBe(false);
    t.screen.mockInput.pressTab();
    await t.until("Change and descendants: 4 changes");
    for (const item of [source, left, right, merge]) expect(marked(item.commitId)).toBe(true);
    expect(marked(destination.commitId)).toBe(false);
    t.screen.mockInput.pressTab();
    await t.until("Selected change only");
    for (const item of [left, right, merge]) expect(marked(item.commitId)).toBe(false);
    t.screen.mockInput.pressEscape();
    await t.until("Cancelled.");
    expect(marked(source.commitId)).toBe(false);

    t.screen.mockInput.pressKey(" ");
    t.choose("Rebase change and descendants");
    await t.until("Will rebase 4 changes");
    for (const item of [source, left, right, merge]) expect(marked(item.commitId)).toBe(true);
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressEnter();
    await t.until("Only this change");
    await t.until("Choose a destination first.");
    for (const item of [left, right, merge]) expect(marked(item.commitId)).toBe(false);
    t.screen.mockInput.pressEscape();
    await t.until("Change preview");

    t.screen.mockInput.pressKey("/");
    await t.prompt(source.changeId);
    t.screen.resize(80, 24);
    t.screen.mockInput.pressKey("R");
    await t.until("Selected change only");
    t.screen.mockInput.pressTab();
    await t.until("3 outside view");
    expect(t.screen.captureCharFrame()).toContain("4 changes");
    t.screen.mockInput.pressEscape();
    await t.until("Cancelled.");
    expect(await t.repo.operationId()).toBe(before);
  } finally { await t.cleanup(); }
}, 15_000);

test("inline rebase cancels without writes, retains a failed destination, and retries", async () => {
  const t = await setup();
  try {
    const source = (await t.repo.snapshot("@")).revisions[0];
    if (!source) throw new Error("Missing source");
    const before = await t.repo.operationId();
    t.screen.mockInput.pressKey("R");
    await t.until("Rebase from ●");
    t.screen.mockInput.pressTab();
    await t.until("Change and descendants");
    t.screen.mockInput.pressEscape();
    await t.until("Cancelled.");
    expect(await t.repo.operationId()).toBe(before);
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressKey("R");
    await t.until("Selected change only");
    t.screen.mockInput.pressTab();
    t.screen.mockInput.pressKey("k");
    t.screen.mockInput.pressEnter();
    await t.until("Error");
    expect(t.screen.captureCharFrame()).toContain("Rebase from ●");
    expect(await t.repo.operationId()).toBe(before);
    t.screen.mockInput.pressTab();
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    await t.until("Current tree");
    await t.until("After rebase");
    expect(await t.repo.operationId()).toBe(before);
    t.screen.mockInput.pressEnter();
    await t.until("rebase completed");
    const rebased = (await t.repo.snapshot("feature")).revisions[0];
    const destination = (await t.repo.snapshot(source.changeId)).revisions[0];
    if (!rebased || !destination) throw new Error("Missing rebase result");
    expect(rebased.parents).toEqual([destination.commitId]);
    expect(t.screen.captureCharFrame()).not.toContain("Rebase from ●");
  } finally { await t.cleanup(); }
}, 15_000);

async function bookmarkDragTargets(t: Awaited<ReturnType<typeof setup>>, name = "feature", remote = "") {
  await t.screen.renderOnce();
  const snapshot = await t.repo.snapshot("all()");
  const bookmarks = await t.repo.bookmarks();
  const source = bookmarks.find(bookmark => bookmark.name === name && bookmark.remote === remote);
  const sourceRow = snapshot.graph.findIndex(row => row.kind === "revision" && source?.targets.includes(row.revision.commitId));
  const row = snapshot.graph[sourceRow];
  if (!row || row.kind !== "revision") throw new Error("Missing bookmark source row");
  const badgeIndex = bookmarks.filter(bookmark => bookmark.targets.includes(row.revision.commitId)).findIndex(bookmark => bookmark.name === name && bookmark.remote === remote);
  const badge = t.screen.renderer.root.findDescendantById(`bookmark-${sourceRow}-${badgeIndex}`);
  const targetIndex = snapshot.graph.findIndex(row => row.kind === "revision" && row.revision.workingCopy);
  const target = t.screen.renderer.root.findDescendantById(`revision-row-${targetIndex}`);
  const destination = snapshot.revisions.find(revision => revision.workingCopy);
  if (!badge || !target || !destination) throw new Error("Missing drag target");
  return { badge, target, destination };
}

test("dragging an individual bookmark highlights a change and moves only after confirmation", async () => {
  const t = await setup();
  try {
    await t.f.jj("bookmark", "create", "aaa", "-r", "feature");
    t.screen.mockInput.pressKey("r");
    await t.until("Ready.");
    const { badge, target, destination } = await bookmarkDragTargets(t);
    const before = await t.repo.bookmarks();
    await t.screen.mockMouse.pressDown(badge.x + 2, badge.y);
    await t.screen.mockMouse.emitMouseEvent("drag", target.x + 2, target.y);
    await t.until("Move feature →");
    expect(t.screen.captureCharFrame()).toContain(`→ @`);
    await t.screen.mockMouse.release(target.x + 2, target.y);
    await t.until("Confirm operation");
    expect(await t.repo.bookmarks()).toEqual(before);
    expect(t.screen.captureCharFrame()).toContain("bookmark-move feature");
    t.screen.mockInput.pressEnter();
    await t.until("Bookmark move completed");
    const after = await t.repo.bookmarks();
    expect(after.find(bookmark => bookmark.name === "feature")?.targets).toEqual([destination.commitId]);
    expect(after.find(bookmark => bookmark.name === "aaa")?.targets).toEqual(before.find(bookmark => bookmark.name === "aaa")?.targets);
    await t.until("[feature]");
  } finally { await t.cleanup(); }
}, 15_000);

test("bookmark click, same-change drop, outside drop, Escape and right drag do not move bookmarks", async () => {
  const t = await setup();
  try {
    const { badge, target } = await bookmarkDragTargets(t);
    const before = await t.repo.operationId();
    await t.screen.mockMouse.click(badge.x + 2, badge.y);
    for (const mode of ["same", "outside", "escape", "right"]) {
      const button = mode === "right" ? 2 : 0;
      await t.screen.mockMouse.pressDown(badge.x + 2, badge.y, button);
      await t.screen.mockMouse.emitMouseEvent("drag", badge.x + 3, badge.y, button);
      if (mode === "escape") t.screen.mockInput.pressEscape();
      const x = mode === "outside" ? 90 : mode === "same" ? badge.x + 3 : target.x + 2;
      const y = mode === "same" ? badge.y : target.y;
      await t.screen.mockMouse.release(x, y, button);
      await t.screen.renderOnce();
      expect(t.screen.captureCharFrame()).not.toContain("Confirm operation");
      expect(t.screen.captureCharFrame()).not.toContain("release to preview");
      expect(await t.repo.operationId()).toBe(before);
    }
  } finally { await t.cleanup(); }
}, 15_000);

test("bookmark drop confirmation can be cancelled and rejects an external operation", async () => {
  const t = await setup();
  try {
    const { badge, target } = await bookmarkDragTargets(t);
    const before = await t.repo.bookmarks();
    async function drop() {
      await t.screen.mockMouse.drag(badge.x + 2, badge.y, target.x + 2, target.y);
      await t.until("Confirm operation");
    }
    await drop();
    t.screen.mockInput.pressEscape();
    await t.until("Empty change.");
    expect(await t.repo.bookmarks()).toEqual(before);
    await drop();
    await t.f.jj("bookmark", "create", "external");
    t.screen.mockInput.pressEnter();
    await t.until("Repository changed");
    expect((await t.repo.bookmarks()).find(bookmark => bookmark.name === "feature")).toEqual(before.find(bookmark => bookmark.name === "feature"));
  } finally { await t.cleanup(); }
}, 15_000);

test("remote bookmark labels stay read-only and overlays block bookmark drags", async () => {
  const t = await setup();
  try {
    t.screen.resize(120, 30);
    const { badge, target } = await bookmarkDragTargets(t, "feature", "git");
    const before = await t.repo.operationId();
    await t.screen.mockMouse.drag(badge.x + 2, badge.y, target.x + 2, target.y);
    await t.screen.renderOnce();
    expect(t.screen.captureCharFrame()).not.toContain("Confirm operation");
    expect(await t.repo.operationId()).toBe(before);
    const local = await bookmarkDragTargets(t);
    t.screen.mockInput.pressKey("b");
    await t.until("Bookmarks");
    await t.until("Ready.");
    await t.screen.mockMouse.drag(local.badge.x + 2, local.badge.y, local.target.x + 2, local.target.y);
    await t.screen.renderOnce();
    expect(t.screen.captureCharFrame()).not.toContain("Confirm operation");
    expect(await t.repo.operationId()).toBe(before);
  } finally { await t.cleanup(); }
}, 15_000);

test("dragging a change previews a rebase and applies only after confirmation", async () => {
  const t = await setup();
  try {
    const { badge, target, destination } = await bookmarkDragTargets(t);
    const snapshot = await t.repo.snapshot("all()");
    const source = snapshot.revisions.find(revision => revision.description.trim() === "Initial feature");
    if (!source) throw new Error("Missing source change");
    const before = await t.repo.operationId();
    await t.screen.mockMouse.pressDown(target.x + 3, badge.y);
    await t.screen.mockMouse.emitMouseEvent("drag", target.x + 3, target.y);
    await t.screen.renderOnce();
    expect(t.screen.captureCharFrame()).toContain("only this change");
    expect(t.screen.captureCharFrame()).toContain("→");
    await t.screen.mockMouse.release(target.x + 3, target.y);
    await t.until("Confirm operation");
    await t.until("Ready.");
    expect(await t.repo.operationId()).toBe(before);
    t.screen.mockInput.pressEnter();
    await t.until("rebase completed");
    const after = await t.repo.snapshot("all()");
    const moved = after.revisions.find(revision => revision.changeId === source.changeId);
    const parent = after.revisions.find(revision => revision.changeId === destination.changeId);
    if (!parent) throw new Error("Missing destination after rebase");
    expect(moved?.parents).toEqual([parent.commitId]);
  } finally { await t.cleanup(); }
}, 15_000);

test("change clicks, invalid drops, Escape and cancelled previews do not rebase", async () => {
  const t = await setup();
  try {
    const { badge, target } = await bookmarkDragTargets(t);
    const x = target.x + 3;
    const before = await t.repo.operationId();
    await t.screen.mockMouse.click(x, badge.y);
    for (const mode of ["same", "outside", "escape", "right"]) {
      const button = mode === "right" ? 2 : 0;
      await t.screen.mockMouse.pressDown(x, badge.y, button);
      await t.screen.mockMouse.emitMouseEvent("drag", x + 1, badge.y, button);
      if (mode === "escape") t.screen.mockInput.pressEscape();
      await t.screen.mockMouse.release(mode === "outside" ? 90 : x, mode === "same" ? badge.y : target.y, button);
      await t.screen.renderOnce();
      expect(t.screen.captureCharFrame()).not.toContain("Confirm operation");
      expect(await t.repo.operationId()).toBe(before);
    }
    await t.screen.mockMouse.drag(x, badge.y, x, target.y);
    await t.until("Confirm operation");
    await t.until("Ready.");
    t.screen.mockInput.pressEscape();
    await t.until("diff --git");
    expect(t.screen.captureCharFrame()).not.toContain("Confirm operation");
    expect(await t.repo.operationId()).toBe(before);
  } finally { await t.cleanup(); }
}, 15_000);

for (const flow of ["confirmation", "form"] as const) {
  test(`${flow} closes after a successful write even if refreshing the graph fails`, async () => {
    const t = await setup();
    const source = (await t.repo.snapshot("@")).revisions[0];
    if (!source) throw new Error("Missing source");
    let reload: ReturnType<typeof spyOn<typeof t.repo, "snapshot">> | undefined;
    try {
      if (flow === "confirmation") {
        t.screen.mockInput.pressKey("n");
        await t.until("Create child");
      } else {
        t.screen.mockInput.pressKey(" ");
        t.choose("Rebase change");
        await t.until("Destination: Choose a revision");
        t.screen.mockInput.pressEnter();
        await t.until("j/k choose");
        const choices = t.screen.renderer.root.findDescendantById("history-choices");
        if (!(choices instanceof SelectRenderable)) throw new Error("Missing destinations");
        for (let i = 0; i < choices.options.length - 1; i++) t.screen.mockInput.pressKey("j");
        t.screen.mockInput.pressEnter();
        await t.until("Preview ready");
        t.screen.mockInput.pressKey("j");
        t.screen.mockInput.pressKey("j");
      }
      // Preparation itself reads snapshots; fail only the post-write refresh.
      const snapshot = t.repo.snapshot.bind(t.repo);
      const apply = t.repo.apply.bind(t.repo);
      const write = spyOn(t.repo, "apply").mockImplementation(async prepared => {
        await apply(prepared);
        reload = spyOn(t.repo, "snapshot").mockRejectedValue(new Error("Graph unavailable"));
      });
      try {
        t.screen.mockInput.pressEnter();
        await t.until("Operation succeeded, but refresh failed");
        reload?.mockRestore();
        expect(t.screen.renderer.root.findDescendantById("action-overlay")?.visible).toBe(false);
        expect(t.screen.renderer.root.findDescendantById("history-form")).toBeUndefined();
        const current = (await snapshot("@")).revisions[0];
        if (flow === "confirmation") expect(current?.parents).toContain(source.commitId);
        else expect(current?.parents).toEqual(["0".repeat(40)]);
        const operation = await t.repo.operationId();
        t.screen.mockInput.pressEnter();
        await t.until("Change preview");
        expect(await t.repo.operationId()).toBe(operation);
        expect(write).toHaveBeenCalledTimes(1);
      } finally { write.mockRestore(); }
    } finally { reload?.mockRestore(); await t.cleanup(); }
  }, 15_000);
}

test("rebase form cannot apply its previous review while scope is reloading", async () => {
  const t = await setup();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const originalScope = t.repo.rebaseScope.bind(t.repo);
  const apply = spyOn(t.repo, "apply");
  try {
    t.screen.mockInput.pressKey(" ");
    t.choose("Rebase change");
    await t.until("Destination: Choose a revision");
    t.screen.mockInput.pressEnter();
    await t.until("j/k choose");
    const choices = t.screen.renderer.root.findDescendantById("history-choices");
    const fields = t.screen.renderer.root.findDescendantById("history-fields");
    if (!(choices instanceof SelectRenderable) || !(fields instanceof SelectRenderable)) throw new Error("Missing rebase fields");
    choices.setSelectedIndex(choices.options.length - 1);
    t.screen.mockInput.pressEnter();
    await t.until("Preview ready");
    t.repo.rebaseScope = async (revision, operationId) => {
      started.resolve();
      await gate.promise;
      return originalScope(revision, operationId);
    };
    t.screen.mockInput.pressKey("p");
    await started.promise;
    fields.setSelectedIndex(2);
    t.screen.mockInput.pressEnter();
    await Bun.sleep(100);
    expect(apply).not.toHaveBeenCalled();
    gate.resolve();
    await t.until("Preview ready");
  } finally {
    gate.resolve();
    apply.mockRestore();
    await t.cleanup();
  }
}, 15_000);

test("split second-description choice cancels without writes and preserves multiline text", async () => {
  const t = await setup();
  try {
    const description = "Original subject\n\nOriginal body";
    await t.f.jj("describe", "-m", description);
    await Bun.write(`${t.f.path}/one.txt`, "one\n");
    await Bun.write(`${t.f.path}/two.txt`, "two\n");
    t.screen.mockInput.pressKey("r");
    await t.until("Ready.");
    const original = (await t.repo.snapshot("@")).revisions[0]!;
    const before = await t.repo.operationId();
    for (const cancel of [true, false]) {
      t.screen.mockInput.pressKey(" ");
      t.choose("Split change");
      await t.until("Continue with 0 files");
      await t.until("Ready.");
      t.choose("[ ] one.txt");
      t.screen.mockInput.pressKey("k");
      t.choose("Continue with 1 files");
      await t.until("First change description");
      await t.screen.mockInput.typeText("Selected files");
      t.screen.mockInput.pressEnter();
      await t.until("Keep original description");
      if (cancel) {
        t.screen.mockInput.pressEscape();
        await t.until("Change preview");
        expect(await t.repo.operationId()).toBe(before);
      } else {
        t.choose("Keep original description");
        await t.until("Confirm operation");
        await t.until("Original body");
        t.screen.mockInput.pressEnter();
        await t.until("Ready.");
        const first = (await t.repo.snapshot(original.changeId)).revisions[0]!;
        const second = (await t.repo.snapshot(`${first.commitId}+`)).revisions[0]!;
        expect(second.description.trim()).toBe(description);
      }
    }
  } finally { await t.cleanup(); }
}, 15_000);

for (const kitty of [false, true]) {
  test(`description supports newlines, paste, reopen and cancel, Kitty=${kitty}`, async () => {
    const t = await setup(kitty);
    try {
      t.screen.mockInput.pressKey("d");
      await t.until("Shift/Alt+Enter newline");
      const editor = t.screen.renderer.root.findDescendantById("description-input") as TextareaRenderable;
      t.screen.mockInput.pressKey("a", { ctrl: true });
      t.screen.mockInput.pressKey("k", { ctrl: true });
      await t.screen.mockInput.typeText("Title");
      const newline = () => kitty ? t.screen.mockInput.pressKey("RETURN", { shift: true }) : t.screen.mockInput.pressKey("RETURN", { meta: true });
      newline();
      newline();
      await t.screen.mockInput.pasteBracketedText("First paragraph\nSecond line");
      expect(editor.plainText).toBe("Title\n\nFirst paragraph\nSecond line");
      expect((await t.repo.snapshot("@")).revisions[0]?.description.trim()).toBe("Next change");
      t.screen.mockInput.pressEnter();
      await t.until("Ready.");
      expect((await t.repo.snapshot("@")).revisions[0]?.description).toBe("Title\n\nFirst paragraph\nSecond line\n");
      t.screen.mockInput.pressKey("d");
      await t.until("Shift/Alt+Enter newline");
      expect(editor.plainText).toBe("Title\n\nFirst paragraph\nSecond line");
      await t.screen.mockInput.typeText("Discard this");
      t.screen.mockInput.pressEscape();
      expect((await t.repo.snapshot("@")).revisions[0]?.description).toBe("Title\n\nFirst paragraph\nSecond line\n");
    } finally { await t.cleanup(); }
  });
}

test("description editor scrolls long text and retains it after a failed save", async () => {
  const t = await setup();
  try {
    const description = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n");
    t.screen.mockInput.pressKey("d");
    await t.until("Shift/Alt+Enter newline");
    const editor = t.screen.renderer.root.findDescendantById("description-input") as TextareaRenderable;
    t.screen.mockInput.pressKey("a", { ctrl: true });
    t.screen.mockInput.pressKey("k", { ctrl: true });
    await t.screen.mockInput.pasteBracketedText(description);
    await t.until("Line 40");
    expect(editor.scrollY).toBeGreaterThan(0);
    const prepare = spyOn(t.repo, "prepare").mockRejectedValueOnce(new Error("Description save failed"));
    try {
      t.screen.mockInput.pressEnter();
      await t.until("Description save failed");
      expect(editor.plainText).toBe(description);
      expect(editor.focused).toBe(true);
    } finally { prepare.mockRestore(); }
    t.screen.mockInput.pressEnter();
    await t.until("Ready.");
    expect((await t.repo.snapshot("@")).revisions[0]?.description).toBe(description + "\n");
  } finally { await t.cleanup(); }
});

test("preview toggle expands the graph, keeps focus visible, and preserves selection", async () => {
  const t = await setup();
  try {
    await t.until("Empty change.");
    const pane = t.screen.renderer.root.findDescendantById("preview")!;
    const graph = t.screen.renderer.root.findDescendantById("revision-pane")!;
    t.screen.mockInput.pressTab();
    expect(pane.focused).toBe(true);
    t.screen.mockInput.pressKey("p");
    await t.screen.renderOnce();
    expect(pane.visible).toBe(false);
    expect(pane.focused).toBe(false);
    expect(graph.width).toBe(t.screen.renderer.width);
    expect(t.screen.captureCharFrame()).not.toContain("┬");
    t.screen.mockInput.pressTab();
    expect(pane.focused).toBe(false);
    t.screen.mockInput.pressKey("j");
    t.screen.mockInput.pressKey("p");
    await t.until("+ hello from jj-evolved");
    expect(pane.visible).toBe(true);
    expect(graph.width).toBeLessThan(t.screen.renderer.width);
    expect(t.screen.captureCharFrame()).toContain("┬");
    t.screen.mockInput.pressKey("p");
    t.screen.mockInput.pressKey("d");
    await t.until("Shift/Alt+Enter newline");
    const editor = t.screen.renderer.root.findDescendantById("description-input") as TextareaRenderable;
    await t.screen.mockInput.typeText("p");
    expect(editor.plainText).toContain("p");
    expect(pane.visible).toBe(false);
    t.screen.mockInput.pressEscape();
    await Bun.sleep(50);
    expect(pane.visible).toBe(false);
    t.screen.resize(80, 24);
    await t.screen.renderOnce();
    expect(graph.width).toBe(80);
    for (const key of ["?", "s", "RETURN"]) {
      t.screen.mockInput.pressKey(key);
      await t.screen.renderOnce();
      expect({ key, visible: pane.visible }).toEqual({ key, visible: true });
      t.screen.mockInput.pressKey("p");
      expect(pane.visible).toBe(false);
    }
  } finally { await t.cleanup(); }
});

test("terminal focus refreshes external edits and status while preserving selection and revset", async () => {
  const t = await setup();
  try {
    t.screen.mockInput.pressKey("/");
    await t.prompt("@ | feature");
    t.screen.mockInput.pressKey("j");
    await t.until("+ hello from jj-evolved");
    await t.f.jj("describe", "-r", "feature", "-m", "Renamed outside the app");
    t.screen.renderer.emit("focus");
    await t.until("Renamed outside the app");
    await t.until("Ready.");
    expect(t.screen.captureCharFrame()).toContain("revset: @ | feature");
    expect(t.screen.captureCharFrame()).toContain("+ hello from jj-evolved");
    t.screen.mockInput.pressKey("s");
    await t.until("Working-copy status");
    await Bun.write(`${t.f.path}/external.txt`, "external edit\n");
    t.screen.renderer.emit("focus");
    await t.until("external.txt");
    expect(t.screen.captureCharFrame()).toContain("Working-copy status");
  } finally { await t.cleanup(); }
}, 15_000);

test("focus refresh keeps input drafts, coalesces deferred events, and detaches on stop", async () => {
  const t = await setup();
  const snapshot = spyOn(t.repo, "snapshot");
  try {
    t.screen.mockInput.pressKey("d");
    await t.screen.mockInput.typeText(" draft kept");
    await t.f.jj("bookmark", "create", "external");
    t.screen.renderer.emit("focus");
    t.screen.renderer.emit("focus");
    await t.until("refresh pending");
    expect(t.screen.captureCharFrame()).toContain("draft kept");
    expect(snapshot).toHaveBeenCalledTimes(0);
    t.screen.mockInput.pressEscape();
    await t.until("external");
    await t.until("Ready.");
    expect(snapshot).toHaveBeenCalledTimes(1);
    t.app.stop();
    t.screen.renderer.emit("focus");
    await Bun.sleep(30);
    expect(snapshot).toHaveBeenCalledTimes(1);
  } finally { snapshot.mockRestore(); await t.cleanup(); }
}, 15_000);

test("focus invalidates a reviewed operation until it is reviewed again", async () => {
  const t = await setup();
  try {
    t.screen.mockInput.pressKey(" ");
    t.choose("Abandon change");
    await t.until("Ready.");
    const operation = await t.repo.operationId();
    t.screen.renderer.emit("focus");
    await t.until("Preview may be stale");
    t.screen.mockInput.pressEnter();
    await t.until("Review the action again");
    expect(await t.repo.operationId()).toBe(operation);
    t.screen.mockInput.pressKey("p");
    await t.until("Ready.");
    t.screen.mockInput.pressEnter();
    await t.until("abandon completed");
  } finally { await t.cleanup(); }
}, 15_000);

for (const view of ["selection", "help", "status"] as const) {
  test(`focus refresh retains ${view} navigation performed while loading`, async () => {
    const t = await setup();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const original = t.repo.snapshot.bind(t.repo);
    t.repo.snapshot = async (...args) => {
      started.resolve();
      await gate.promise;
      return original(...args);
    };
    try {
      t.screen.renderer.emit("focus");
      await started.promise;
      t.screen.mockInput.pressKey(view === "selection" ? "j" : view === "help" ? "?" : "s");
      const text = view === "selection" ? "+ hello from jj-evolved" : view === "help" ? "Keyboard reference" : "Working-copy status";
      await t.until(text);
      gate.resolve();
      await t.until("Ready.");
      expect(t.screen.captureCharFrame()).toContain(text);
    } finally { gate.resolve(); await t.cleanup(); }
  }, 15_000);
}

test("focus events during refresh produce one follow-up", async () => {
  const t = await setup();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = t.repo.snapshot.bind(t.repo);
  let calls = 0;
  t.repo.snapshot = async (...args) => {
    calls++;
    if (calls === 1) { started.resolve(); await gate.promise; }
    return original(...args);
  };
  try {
    t.screen.renderer.emit("focus");
    await started.promise;
    t.screen.renderer.emit("focus");
    t.screen.renderer.emit("focus");
    gate.resolve();
    for (let attempt = 0; calls < 2 && attempt < 150; attempt++) await Bun.sleep(10);
    await t.until("Ready.");
    expect(calls).toBe(2);
    t.app.stop();
    t.screen.renderer.emit("focus");
    await Bun.sleep(30);
    expect(calls).toBe(2);
  } finally { gate.resolve(); await t.cleanup(); }
}, 15_000);

test("focus preserves help and defers refresh while a filtered target is temporarily revealed", async () => {
  const t = await setup();
  const snapshot = spyOn(t.repo, "snapshot");
  try {
    t.screen.mockInput.pressKey("?");
    await t.until("Keyboard reference");
    t.screen.renderer.emit("focus");
    await Promise.resolve();
    await t.until("Ready.");
    expect(t.screen.captureCharFrame()).toContain("Keyboard reference");
    t.screen.mockInput.pressKey("/");
    await t.prompt("@");
    t.screen.mockInput.pressKey("[");
    await t.until("temporary view");
    await t.until("Ready.");
    const count = snapshot.mock.calls.length;
    await t.f.jj("bookmark", "create", "fresh-working-copy");
    t.screen.renderer.emit("focus");
    await t.until("Focus refresh pending");
    expect(snapshot).toHaveBeenCalledTimes(count);
    expect(t.screen.captureCharFrame()).toContain("Initial feature");
    t.screen.mockInput.pressKey("o", { ctrl: true });
    await t.until("fresh-working-copy");
    await t.until("Ready.");
    expect(t.screen.captureCharFrame()).toContain("revset: @");
    expect(t.screen.captureCharFrame()).not.toContain("temporary view");
  } finally { snapshot.mockRestore(); await t.cleanup(); }
}, 15_000);

test("stopping while a focus refresh is reading discards its result", async () => {
  const t = await setup();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const snapshot = await t.repo.snapshot("all()");
  t.repo.snapshot = async () => { started.resolve(); await gate.promise; return snapshot; };
  t.repo.bookmarks = async () => { finished.resolve(); return []; };
  try {
    t.screen.renderer.emit("focus");
    await started.promise;
    t.app.stop();
    gate.resolve();
    await finished.promise;
    await Bun.sleep(20);
    expect(t.screen.renderer.root.findDescendantById("app")).toBeUndefined();
  } finally { gate.resolve(); await t.cleanup(); }
}, 15_000);

test("focus refresh preserves accepted search and preview scroll", async () => {
  const t = await setup();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  try {
    await Bun.write(`${t.f.path}/long.txt`, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
    t.screen.mockInput.pressKey("r");
    await t.until("+ line 0");
    await t.until("Ready.");
    t.screen.mockInput.pressKey("f", { ctrl: true });
    await t.until("Type to search");
    await t.screen.mockInput.typeText("Next change");
    t.screen.mockInput.pressEnter();
    await t.until("1/1");
    await t.until("+ line 0");
    await t.screen.waitForVisualIdle();
    const original = t.repo.snapshot.bind(t.repo);
    t.repo.snapshot = async (...args) => {
      started.resolve();
      await gate.promise;
      return original(...args);
    };
    t.screen.renderer.emit("focus");
    await started.promise;
    t.screen.mockInput.pressKey("\x1b[6~");
    await t.screen.renderOnce();
    const preview = t.screen.renderer.root.findDescendantById("preview") as import("@opentui/core").ScrollBoxRenderable;
    const top = preview.scrollTop;
    expect(top).toBeGreaterThan(0);
    gate.resolve();
    await t.until("Ready.");
    expect(preview.scrollTop).toBe(top);
    expect(t.screen.captureCharFrame()).toContain("1/1");
    expect(t.screen.captureCharFrame()).toContain("Next change");
  } finally { gate.resolve(); await t.cleanup(); }
}, 15_000);

test("focus refresh does not restore scroll over help opened during a pending diff", async () => {
  const t = await setup();
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = t.repo.diff.bind(t.repo);
  t.repo.diff = async (...args) => {
    started.resolve();
    await gate.promise;
    return original(...args);
  };
  try {
    t.screen.renderer.emit("focus");
    await started.promise;
    t.screen.mockInput.pressKey("?");
    await t.until("Keyboard reference");
    await t.screen.waitForVisualIdle();
    t.screen.mockInput.pressKey("\x1b[6~");
    await t.screen.renderOnce();
    const preview = t.screen.renderer.root.findDescendantById("preview") as import("@opentui/core").ScrollBoxRenderable;
    const top = preview.scrollTop;
    expect(top).toBeGreaterThan(0);
    gate.resolve();
    await t.until("Ready.");
    expect(String(preview.title).trim()).toBe("Help");
    expect(preview.scrollTop).toBe(top);
  } finally { gate.resolve(); await t.cleanup(); }
}, 15_000);
