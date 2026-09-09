import { expect, test } from "bun:test";
import { SelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../src/app";
import { Repository } from "../src/repository";
import { fixture } from "./fixture";

async function setup() {
  const f = await fixture();
  const screen = await createTestRenderer({ width: 100, height: 30 });
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

test("keyboard browsing, status, help, revsets and empty state at 80x24", async () => {
  const t = await setup();
  try {
    await t.until("Empty change.");
    t.screen.mockInput.pressKey("j");
    await t.until("+hello from jj-evolved");
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

test("invalid revset preserves history and multiline descriptions are refused", async () => {
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
    await t.until("multiple lines");
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
  const delayed: Repository = {
    root: repo.root,
    snapshot: revset => repo.snapshot(revset),
    status: () => repo.status(),
    prepare: action => repo.prepare(action),
    apply: prepared => repo.apply(prepared),
    operations: limit => repo.operations(limit),
    operationId: () => repo.operationId(),
    operationDiff: operation => repo.operationDiff(operation),
    bookmarks: () => repo.bookmarks(),
    files: revision => repo.files(revision),
    diff: async revision => {
      if (first) {
        first = false;
        started.resolve();
        await gate.promise;
      }
      return repo.diff(revision);
    },
  };
  const app = createApp(screen.renderer, delayed);
  try {
    const loading = app.start();
    await started.promise;
    screen.mockInput.pressKey("j");
    for (let attempt = 0; attempt < 100; attempt++) {
      await screen.renderOnce();
      if (screen.captureCharFrame().includes("+hello from jj-evolved")) break;
      await Bun.sleep(10);
    }
    expect(screen.captureCharFrame()).toContain("+hello from jj-evolved");
    gate.resolve();
    await loading;
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("+hello from jj-evolved");
  } finally {
    gate.resolve();
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
    await t.until("Confirm operation");
    t.screen.mockInput.pressEnter();
    await t.until("Ready.");
    const first = (await t.repo.snapshot(original.changeId)).revisions[0];
    if (!first) throw new Error("Missing first split change");
    expect(first.description.trim()).toBe("First group");
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
    await t.until("Before");
    await t.until("After");
    const treeText = t.screen.renderer.root.findDescendantById("confirmation-trees-after");
    const beforeText = t.screen.renderer.root.findDescendantById("confirmation-trees-before");
    if (!treeText || !beforeText) throw new Error("Missing confirmation trees");
    expect(beforeText.x).toBeLessThan(treeText.x);
    expect(beforeText.y).toBe(treeText.y);
    expect(t.screen.captureCharFrame().split("\n").some(line => line[beforeText.x] === "│")).toBe(true);
    expect(t.screen.captureCharFrame().split("\n").some(line => line[treeText.x] === "│")).toBe(true);
    t.screen.resize(120, 30);
    await t.screen.renderOnce();
    expect(beforeText.x).toBeLessThan(treeText.x);
    expect(beforeText.y).toBe(treeText.y);
    expect(await t.repo.operationId()).toBe(before);
    t.screen.mockInput.pressEscape();
    await t.until("Enter preview");
    expect(t.screen.captureCharFrame()).toContain("Squash from ●");
    t.screen.mockInput.pressEnter();
    await t.until("Confirm operation");
    await t.until("Before");
    await t.until("After");
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
    await t.until("Before");
    await t.until("After");
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
