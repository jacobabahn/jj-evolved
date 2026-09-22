import { expect, spyOn, test } from "bun:test";
import { InputRenderable, SelectRenderable, TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../src/app";
import { Repository } from "../src/repository/repository";
import { RevisionLog } from "../src/revisions/revision-log";
import { fixture } from "./fixture";

async function setup(prepare: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> = async () => {}, interval = 0) {
  const f = await fixture();
  await prepare(f);
  const repo = await Repository.open(f.path);
  const screen = await createTestRenderer({ width: 110, height: 32 });
  const app = createApp(screen.renderer, repo, undefined, undefined, undefined, { refreshIntervalMs: interval });
  await app.start();
  const node = <T>(id: string) => screen.renderer.root.findDescendantById(id) as T;
  async function until(predicate: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 400; i++) {
      await screen.renderOnce();
      if (await predicate()) return;
      await Bun.sleep(10);
    }
    throw new Error(screen.captureCharFrame());
  }
  const text = (value: string) => until(() => screen.captureCharFrame().includes(value));
  async function choose(name: string, id = "action-choices") {
    await until(() => node<SelectRenderable>(id)?.options.some(option => option.name === name));
    const choices = node<SelectRenderable>(id);
    choices.setSelectedIndex(choices.options.findIndex(option => option.name === name));
    screen.mockInput.pressEnter();
  }
  async function escape() { screen.mockInput.pressEscape(); await Bun.sleep(60); }
  async function searchDestination(query: string, id = "destination-search") {
    screen.mockInput.pressKey("/");
    await until(() => Boolean(node<InputRenderable>(id)?.visible));
    await screen.mockInput.typeText(query);
    await screen.renderOnce();
  }
  return { f, repo, screen, app, node, until, text, choose, escape, searchDestination,
    cleanup: async () => { app.stop(); screen.renderer.destroy(); await f.cleanup(); } };
}

test("destination search reaches old revisions in bookmark, history form and inline pickers", async () => {
  const t = await setup(async f => {
    for (let i = 0; i < 202; i++) await f.jj("new", "-m", `Filler ${i}`);
    await f.jj("bookmark", "create", "work");
  });
  try {
    const target = (await t.repo.navigationRevisions("feature"))[0]!;
    expect((await t.repo.snapshot("all()", true)).revisions.some(item => item.commitId === target.commitId)).toBe(false);
    const operation = await t.repo.operationId();
    t.screen.mockInput.pressKey("b");
    await t.choose("work");
    await t.choose("Move bookmark");
    await t.until(() => t.node<SelectRenderable>("action-choices").options.length > 200);
    await t.searchDestination("no such destination!");
    await t.text("No matching destinations");
    t.screen.mockInput.pressEnter();
    expect(await t.repo.operationId()).toBe(operation);
    await t.escape();
    await t.searchDestination("FEATURE");
    expect(t.node<SelectRenderable>("action-choices").options).toHaveLength(1);
    t.screen.mockInput.pressEnter();
    await t.text("Confirm operation");
    await t.escape();
    for (const action of ["Rebase change", "Squash changes"]) {
      t.screen.mockInput.pressKey(" ");
      await t.choose(action);
      t.screen.mockInput.pressEnter();
      await t.until(() => Boolean(t.node<SelectRenderable>("history-choices")?.visible));
      expect(t.node<SelectRenderable>("history-choices").options.length).toBeGreaterThan(200);
      await t.searchDestination(target.commitId.slice(0, 16), "history-destination-search");
      expect(t.node<SelectRenderable>("history-choices").options).toHaveLength(1);
      t.screen.mockInput.pressEnter();
      await t.text("Preview ready");
      expect(t.node<SelectRenderable>("history-fields").options[0]?.name).toContain(target.changeId.slice(0, 8));
      await t.escape();
    }
    t.screen.mockInput.pressKey("R");
    await t.text("Ready.");
    await t.searchDestination("Initial feature");
    t.screen.mockInput.pressEnter();
    await t.text("temporary view");
    await t.text("Ready.");
    expect(t.node<RevisionLog>("revisions").getSelectedIndex()).toBeGreaterThanOrEqual(0);
    expect(t.screen.captureCharFrame()).toContain("Initial feature");
    expect(t.node<any>("inline-action").visible).toBe(true);
    await t.escape();
    expect(await t.repo.operationId()).toBe(operation);
    await t.app.checkForUpdates();
    await t.f.jj("describe", "-r", "feature", "-m", "Initial feature updated externally");
    await t.app.checkForUpdates();
    await t.text("Initial feature updated externally");
    expect(t.node<any>("navigation-status").visible).toBe(true);
    t.screen.mockInput.pressKey("o", { ctrl: true });
    await t.text("Filler 201");
    expect(t.node<any>("navigation-status").visible).toBe(false);
  } finally { await t.cleanup(); }
}, 20_000);

test("auto-refresh detects commands and file edits, preserving selection, search and hidden pane", async () => {
  const t = await setup();
  try {
    await t.app.checkForUpdates();
    t.screen.mockInput.pressKey("f", { ctrl: true });
    await t.until(() => t.node<InputRenderable>("search-input").visible);
    await t.screen.mockInput.typeText("Next");
    t.screen.mockInput.pressEnter();
    await t.until(() => !t.node<InputRenderable>("search-input").visible);
    const before = (await t.repo.navigationRevisions("@"))[0]!;
    t.screen.mockInput.pressKey("p");
    await t.f.jj("describe", "-m", "Next externally edited");
    await t.app.checkForUpdates();
    expect(t.node<any>("preview").visible).toBe(false);
    await t.screen.renderOnce();
    expect(t.screen.captureCharFrame()).toContain("| Next");
    const editorTarget = (await t.repo.navigationRevisions("@"))[0]!;
    expect(editorTarget.changeId).toBe(before.changeId);
    t.screen.mockInput.pressKey("d");
    expect(t.node<TextareaRenderable>("description-input").plainText).toBe("Next externally edited");
    await t.escape();
    await Bun.write(`${t.f.path}/hello.txt`, "edited outside the app\n");
    await t.app.checkForUpdates();
    t.screen.mockInput.pressKey("p");
    await t.text("+ edited outside the app");
  } finally { await t.cleanup(); }
});

test("auto-refresh defers during editing and rejects a late result after user input", async () => {
  const t = await setup();
  try {
    await t.app.checkForUpdates();
    t.screen.mockInput.pressKey("d");
    const editor = t.node<TextareaRenderable>("description-input");
    await t.screen.mockInput.typeText("Draft ");
    const draft = editor.plainText;
    await t.f.jj("describe", "-m", "External revision");
    const status = spyOn(t.repo, "status");
    await t.app.checkForUpdates();
    expect(status).not.toHaveBeenCalled();
    status.mockRestore();
    expect(editor.plainText).toBe(draft);
    await t.escape();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const snapshot = t.repo.snapshot.bind(t.repo);
    const mock = spyOn(t.repo, "snapshot").mockImplementation(async (...args) => {
      started.resolve(); await gate.promise; return snapshot(...args);
    });
    const pending = t.app.checkForUpdates();
    await started.promise;
    t.screen.mockInput.pressKey("d");
    const original = editor.plainText;
    gate.resolve();
    await pending;
    mock.mockRestore();
    expect(editor.plainText).toBe(original);
    await t.escape();
    await t.app.checkForUpdates();
    await t.text("External revision");
  } finally { await t.cleanup(); }
});

test("auto-refresh keeps scroll and help, retries errors, and stops polling on disposal", async () => {
  const t = await setup(async f => {
    for (let i = 0; i < 30; i++) await f.jj("new", "-m", `Change ${i}`);
  });
  try {
    await t.app.checkForUpdates();
    const list = t.node<RevisionLog>("revisions");
    list.setSelectedIndex(18);
    list.scrollTop = 10;
    t.screen.mockInput.pressKey("?");
    await t.text("Keyboard reference");
    const pane = t.node<ScrollBoxRenderable>("preview");
    pane.scrollTo(8);
    await t.f.jj("bookmark", "create", "external");
    const failed = spyOn(t.repo, "status").mockRejectedValueOnce(new Error("temporary failure"));
    await t.app.checkForUpdates();
    await t.text("Auto-refresh failed");
    failed.mockRestore();
    await t.app.checkForUpdates();
    expect(list.scrollTop).toBe(10);
    expect(list.getSelectedIndex()).toBe(18);
    expect(pane.scrollTop).toBe(8);
    expect(pane.title).toContain("Help");
    const noChangeFailure = spyOn(t.repo, "status").mockRejectedValueOnce(new Error("retry without new operations"));
    await t.app.checkForUpdates();
    await t.text("Auto-refresh failed");
    noChangeFailure.mockRestore();
    await t.app.checkForUpdates();
    await t.text("Ready.");
    const status = spyOn(t.repo, "status");
    t.app.stop();
    await t.app.checkForUpdates();
    expect(status).not.toHaveBeenCalled();
    status.mockRestore();
  } finally { await t.cleanup(); }
});

test("refresh timer updates the graph without a manual refresh", async () => {
  const t = await setup(undefined, 50);
  try {
    await t.f.jj("describe", "-m", "Timer refreshed this change");
    await t.text("Timer refreshed this change");
  } finally { await t.cleanup(); }
});
