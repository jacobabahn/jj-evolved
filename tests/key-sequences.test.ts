import { expect, test } from "bun:test";
import { join } from "node:path";
import { InputRenderable, SelectRenderable, TextRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";
import { loadKeybindings } from "../src/ui/keybindings";
import type { FileList } from "../src/revisions/file-list";

type Ui = Parameters<Parameters<typeof withUiFixture>[1]>[0];
const footer = (ui: Ui) => (ui.node("shortcuts") as TextRenderable).plainText;
const overlayOpen = (ui: Ui) => ui.screen.renderer.root.findDescendantById("action-overlay")?.visible ?? false;

test("a prefix key waits for the rest of its sequence instead of running an action", () => withUiFixture("key-sequences", async ui => {
  await ui.until("Ready.");
  const selected = () => (ui.node("revisions") as unknown as { getSelectedIndex(): number }).getSelectedIndex?.();
  const start = selected();
  // g is a prefix now: pressing it opens neither the Git menu nor anything else.
  ui.key("g");
  await ui.until("g … then");
  expect(footer(ui)).toContain("g git");
  expect(footer(ui)).toContain("t theme");
  expect(footer(ui)).toContain("Esc cancel");
  await Bun.sleep(60);
  expect(overlayOpen(ui)).toBe(false);
  ui.key("t");
  await ui.until("Theme");
  expect(overlayOpen(ui)).toBe(true);
  ui.key("ESCAPE"); await Bun.sleep(60);
  expect(overlayOpen(ui)).toBe(false);
  // A key that finishes no sequence is swallowed: j does not move the selection.
  ui.key("g"); ui.key("j");
  await ui.until("g j is not bound.");
  expect(selected()).toBe(start);
  expect(footer(ui)).not.toContain("g … then");
  // Escape abandons the sequence without clearing anything else.
  ui.key("g"); ui.key("ESCAPE");
  await ui.until("Cancelled g.");
  expect(overlayOpen(ui)).toBe(false);
  // The sequence for git itself still opens the Git menu.
  ui.key("g"); ui.key("g");
  await ui.until("Fetch");
  expect(overlayOpen(ui)).toBe(true);
  ui.key("ESCAPE"); await Bun.sleep(60);
  // Help lists the sequences.
  ui.key("?");
  await ui.until("Help · custom keys");
}, {
  prepare: async f => { await f.jj("git", "remote", "add", "origin", join(f.path, "missing-remote")); },
  bindings: loadKeybindings({ bindings: { git: ["g g"], theme: ["g t"] } }),
}), 15_000);

test("file browser and menu scopes take their own keys while browsing keeps the defaults", () => withUiFixture("key-scopes", async ui => {
  await ui.until("Ready.");
  const files = () => ui.node("changed-files") as unknown as FileList;
  ui.key("l");
  await ui.until("focus diff");
  expect(files().getSelectedIndex()).toBe(0);
  // In the file browser, j is no longer down, but J is.
  ui.key("j"); await ui.settled();
  expect(files().getSelectedIndex()).toBe(0);
  ui.key("J"); await ui.settled();
  expect(files().getSelectedIndex()).toBe(1);
  ui.key("K"); await ui.settled();
  expect(files().getSelectedIndex()).toBe(0);
  expect(footer(ui)).toContain("J/K file");
  ui.key("h"); await ui.settled();
  expect(footer(ui)).not.toContain("focus diff");
  // Back in the revision list, j still moves and J does nothing.
  const list = ui.node("revisions") as unknown as { getSelectedIndex(): number };
  ui.key("J"); await ui.settled();
  expect(list.getSelectedIndex()).toBe(0);
  ui.key("j"); await ui.settled();
  expect(list.getSelectedIndex()).toBe(1);
  // In menus, back moved from h to ^B; Escape still works.
  ui.key(" ");
  await ui.until("── Edit ──");
  ui.key("h"); await Bun.sleep(60);
  expect(overlayOpen(ui)).toBe(true);
  ui.key("b", { ctrl: true }); await Bun.sleep(60);
  expect(overlayOpen(ui)).toBe(false);
}, {
  prepare: async f => { await Bun.write(join(f.path, "a.txt"), "a\n"); await Bun.write(join(f.path, "b.txt"), "b\n"); },
  bindings: loadKeybindings({ scopes: { files: { down: ["J"], up: ["K"] }, menu: { back: ["ctrl+b"] } } }),
}), 15_000);

test("prompt bindings complete and save while every typed character still reaches the text", () => withUiFixture("key-prompts", async ui => {
  await ui.until("Ready.");
  // The revset prompt completes on ^T; Tab no longer does.
  ui.key("L");
  await ui.until("Revset");
  const input = ui.node("prompt-input") as InputRenderable;
  input.value = "";
  await ui.type("featur");
  ui.screen.mockInput.pressTab(); await ui.settled();
  expect(input.value).toBe("featur");
  ui.key("t", { ctrl: true }); await ui.settled();
  expect(input.value).toBe("feature");
  expect(footer(ui)).toContain("^T/Shift-Tab complete");
  ui.key("ESCAPE"); await Bun.sleep(60);
  // The description editor saves on the two-key sequence ^X ^S. Letters, including x and s, are typed as text.
  const revision = (await ui.repo.snapshot("@")).revisions[0]!;
  ui.key("RETURN");
  await ui.until("Describe");
  ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  await ui.type("xs fix");
  ui.key("s", { ctrl: true }); await Bun.sleep(60);
  expect(overlayOpen(ui)).toBe(true);
  ui.key("x", { ctrl: true });
  await ui.until("^X … then");
  expect(footer(ui)).toContain("^S saveDescription");
  ui.key("s", { ctrl: true });
  await ui.until("Ready.");
  expect((await ui.repo.snapshot(revision.changeId)).revisions[0]?.description.trim()).toBe("xs fix");
}, { bindings: loadKeybindings({ scopes: { prompt: { nextCompletion: ["ctrl+t"], saveDescription: ["ctrl+x ctrl+s"] } } }) }), 15_000);
