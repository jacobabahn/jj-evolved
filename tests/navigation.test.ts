import { expect, test } from "bun:test";
import { InputRenderable, SelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../src/app";
import { Repository } from "../src/repository/repository";
import { RevisionLog } from "../src/revisions/revision-log";
import { fixture } from "./fixture";

async function setup(prepare: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> = async () => {}) {
  const f = await fixture();
  await prepare(f);
  const screen = await createTestRenderer({ width: 80, height: 24 });
  const repo = await Repository.open(f.path);
  const app = createApp(screen.renderer, repo);
  await app.start();
  async function until(text: string) {
    for (let i = 0; i < 200; i++) {
      await screen.renderOnce();
      if (screen.captureCharFrame().includes(text)) return screen.captureCharFrame();
      await Bun.sleep(10);
    }
    throw new Error(`Missing ${text}:\n${screen.captureCharFrame()}`);
  }
  function list() {
    const node = screen.renderer.root.findDescendantById("revisions");
    if (!(node instanceof RevisionLog)) throw new Error("Missing revision list");
    return node;
  }
  async function search(query: string) {
    screen.mockInput.pressKey("f", { ctrl: true });
    for (let i = 0; i < 200; i++) {
      const input = screen.renderer.root.findDescendantById("search-input");
      if (input?.visible) break;
      await Bun.sleep(10);
    }
    await until("Search in revset:");
    const node = screen.renderer.root.findDescendantById("search-input");
    if (!(node instanceof InputRenderable)) throw new Error("Missing search input");
    node.value = query;
    node.emit("input", query);
    await Bun.sleep(140);
  }
  async function filter(query: string) {
    screen.mockInput.pressKey("/");
    await until("Revset");
    const node = screen.renderer.root.findDescendantById("prompt-input");
    if (!(node instanceof InputRenderable)) throw new Error("Missing revset input");
    node.value = query;
    screen.mockInput.pressEnter();
    await until("Ready.");
  }
  return { f, repo, screen, app, until, list, search, filter, cleanup: async () => { app.stop(); screen.renderer.destroy(); await f.cleanup(); } };
}

test("search previews, wraps, cancels and clears without changing the revset or repository", async () => {
  const t = await setup();
  try {
    await t.filter("@ | parents(@)");
    const original = t.list().getSelectedIndex();
    const operation = await t.repo.operationId();
    await Bun.write(`${t.f.path}/unsnapshotted.txt`, "navigation must leave this alone\n");
    await t.search("FEATURE");
    const searching = await t.until("1/1");
    expect(searching).toContain("Enter keep  Esc cancel");
    expect(searching).toContain("*▶");
    expect(t.list().getSelectedIndex()).not.toBe(original);
    t.screen.mockInput.pressEscape();
    await Bun.sleep(80);
    await t.until("Change preview");
    expect(t.list().getSelectedIndex()).toBe(original);
    await t.search("change");
    await t.until("1/1");
    t.screen.mockInput.pressEnter();
    await Bun.sleep(100);
    t.screen.mockInput.pressKey("n", { ctrl: true });
    await Bun.sleep(80);
    await t.until("Ready.");
    expect(t.list().getSelectedIndex()).toBe(original);
    await t.search("missing needle");
    await t.until("No matches");
    expect(t.list().getSelectedIndex()).toBe(original);
    t.screen.mockInput.pressEscape();
    await t.until("1/1");
    t.screen.mockInput.pressEscape();
    await Bun.sleep(80);
    const frame = await t.until("revset: @ | parents(@)");
    expect(frame).not.toContain("Search in revset:");
    expect(frame).toContain("^F search");
    expect(frame).toContain("^N/^P match");
    expect(frame).toContain("@ work");
    expect(await t.repo.operationId()).toBe(operation);
    expect(await Bun.file(`${t.f.path}/unsnapshotted.txt`).text()).toBe("navigation must leave this alone\n");
  } finally { await t.cleanup(); }
}, 15_000);

test("ancestry chooser includes filtered relatives, cancellation and repeated reveals preserve the return point", async () => {
  const t = await setup(async f => {
    await f.jj("bookmark", "create", "left");
    await f.jj("new", "feature", "-m", "Right branch");
    await f.jj("bookmark", "create", "right");
    await f.jj("new", "left", "right", "-m", "Merge branches");
  });
  try {
    await t.filter("@");
    const operation = await t.repo.operationId();
    await Bun.write(`${t.f.path}/dirty.txt`, "stay dirty\n");
    t.screen.mockInput.pressKey("[");
    await t.until("Choose parent");
    const chooser = t.screen.renderer.root.findDescendantById("action-choices");
    if (!(chooser instanceof SelectRenderable)) throw new Error("Missing chooser");
    expect(chooser.options).toHaveLength(2);
    expect(chooser.options.every(option => option.description.includes("outside filter"))).toBe(true);
    t.screen.mockInput.pressEscape();
    await t.until("Change preview");
    expect(t.list().getSelectedIndex()).toBe(0);
    t.screen.mockInput.pressKey("[");
    await t.until("Choose parent");
    t.screen.mockInput.pressEnter();
    await t.until("temporary view");
    await t.until("Ready.");
    t.screen.mockInput.pressKey("[");
    await Bun.sleep(100);
    await t.until("Ready.");
    t.screen.mockInput.pressKey("o", { ctrl: true });
    await Bun.sleep(80);
    const frame = await t.until("revset: @");
    expect(frame).not.toContain("temporary view");
    expect(t.list().getSelectedIndex()).toBe(0);
    expect(await t.repo.operationId()).toBe(operation);
    await t.filter("feature");
    const beforeJump = await t.repo.operationId();
    t.screen.mockInput.pressKey("@");
    await t.until("temporary view");
    await t.until("Merge branches");
    expect(await t.repo.operationId()).toBe(beforeJump);
    expect(beforeJump).not.toBe(operation);
  } finally { await t.cleanup(); }
}, 15_000);

test("search finds history beyond 200 loaded rows and returns to the original view", async () => {
  const t = await setup(async f => {
    for (let i = 0; i < 202; i++) await f.jj("new", "-m", `Filler ${i}`);
  });
  try {
    expect((await t.repo.snapshot("all()", true)).revisions).toHaveLength(200);
    const operation = await t.repo.operationId();
    await t.search("Initial feature");
    await t.until("1/1");
    await t.until("temporary view");
    t.screen.mockInput.pressEnter();
    await Bun.sleep(100);
    t.screen.mockInput.pressKey("o", { ctrl: true });
    const frame = await t.until("Filler 201");
    expect(frame).not.toContain("temporary view");
    expect(t.list().getSelectedIndex()).toBe(0);
    expect(await t.repo.operationId()).toBe(operation);
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const snapshot = t.repo.snapshot.bind(t.repo);
    t.repo.snapshot = async (revset, readOnly) => {
      if (readOnly) { started.resolve(); await gate.promise; }
      return snapshot(revset, readOnly);
    };
    try {
      await t.search("0000000000000000");
      await started.promise;
      t.screen.mockInput.pressEscape();
      await Bun.sleep(80);
      gate.resolve();
      await Bun.sleep(150);
      const cancelled = await t.until("Filler 201");
      expect(cancelled).not.toContain("temporary view");
      expect(t.list().getSelectedIndex()).toBe(0);
      expect(await t.repo.operationId()).toBe(operation);
    } finally { gate.resolve(); }
  } finally { await t.cleanup(); }
}, 30_000);

test("search matches multiline descriptions, bookmark names and both IDs, with next and previous wrapping", async () => {
  const t = await setup(async f => {
    await f.jj("describe", "-m", "Next change\nShared needle in the body");
    await f.jj("describe", "-r", "feature", "-m", "Initial feature\nShared needle too");
    await f.jj("bookmark", "create", "search-bookmark", "-r", "feature");
  });
  try {
    await t.search("SHARED NEEDLE");
    await t.until("1/2");
    t.screen.mockInput.pressEnter();
    await Bun.sleep(80);
    for (const [key, position] of [["n", "2/2"], ["n", "1/2"], ["p", "2/2"]]) {
      if (!key || !position) throw new Error("Missing navigation test case");
      t.screen.mockInput.pressKey(key, { ctrl: true });
      await t.until(position);
      await t.until("Ready.");
    }
    const target = (await t.repo.navigationRevisions("feature"))[0];
    if (!target) throw new Error("Missing feature revision");
    for (const query of ["SEARCH-BOOKMARK", "search-bookmark@git", target.changeId, target.commitId.slice(0, 16)]) {
      await t.search(query);
      await t.until("1/1");
      expect(t.list().getSelectedIndex()).toBe(1);
      t.screen.mockInput.pressEnter();
      await Bun.sleep(80);
    }
  } finally { await t.cleanup(); }
}, 15_000);

test("children include all branches and empty ancestry leaves selection unchanged", async () => {
  const t = await setup(async f => {
    await f.jj("new", "feature", "-m", "Other child");
  });
  try {
    await t.filter("feature");
    const operation = await t.repo.operationId();
    t.screen.mockInput.pressKey("]");
    await t.until("Choose child");
    const chooser = t.screen.renderer.root.findDescendantById("action-choices");
    if (!(chooser instanceof SelectRenderable)) throw new Error("Missing chooser");
    expect(chooser.options).toHaveLength(2);
    t.screen.mockInput.pressEscape();
    await Bun.sleep(80);
    expect(t.list().getSelectedIndex()).toBe(0);
    t.screen.mockInput.pressKey("@");
    await t.until("temporary view");
    await t.until("Ready.");
    const selected = t.list().getSelectedIndex();
    t.screen.mockInput.pressKey("]");
    await t.until("No child.");
    expect(t.list().getSelectedIndex()).toBe(selected);
    expect(await t.repo.operationId()).toBe(operation);
  } finally { await t.cleanup(); }
}, 15_000);

test("loading more history preserves a selection made while loading and resets on revset change", async () => {
  const t = await setup(async f => {
    for (let i = 0; i < 202; i++) await f.jj("new", "-m", `Page ${i}`);
  });
  const gate = Promise.withResolvers<void>();
  try {
    await t.until("L load 200 more");
    const read = t.repo.snapshot.bind(t.repo);
    const started = Promise.withResolvers<void>();
    t.repo.snapshot = async (revset, readOnly, limit) => {
      if (limit === 400) { started.resolve(); await gate.promise; }
      return read(revset, readOnly, limit);
    };
    t.screen.mockInput.pressKey("L");
    await started.promise;
    t.screen.mockInput.pressKey("j");
    const index = t.list().getSelectedIndex();
    gate.resolve();
    const frame = await t.until("205 revisions");
    expect(t.list().getSelectedIndex()).toBe(index);
    expect(frame).not.toContain("L load 200 more");
    await t.until("Ready.");
    await t.filter("feature");
    await t.until("1 revisions");
    await t.until("Ready.");
    await t.filter("all()");
    await t.until("L load 200 more");
  } finally { gate.resolve(); await t.cleanup(); }
}, 15_000);
