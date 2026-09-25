import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";
import { parseKeybindings } from "../src/ui/keybindings";
import type { BoxRenderable, TextRenderable } from "@opentui/core";

test("inline mode restores its pane, confirmation removes duplicate chrome, and focus changes hints", () => withUiFixture("mode-signals", async ui => {
  const graph = ui.node("revision-pane") as BoxRenderable;
  const border = graph.borderColor;
  ui.key("r");
  await ui.until("Rebase: choose destination");
  expect(graph.borderColor).not.toEqual(border);
  ui.key("j"); ui.key("j"); ui.key("RETURN");
  await ui.until("Rebase preview");
  expect(ui.screen.renderer.root.findDescendantById("prompt-label")?.visible).toBe(false);
  expect(ui.screen.renderer.root.findDescendantById("action-overlay-feedback")?.visible).toBe(false);
  expect(ui.screen.captureCharFrame()).not.toContain("Ready.");
  ui.key("ESCAPE");
  await ui.until("Rebase: choose destination");
  ui.key("ESCAPE");
  await ui.until("Cancelled.");
  expect(graph.title).toBe(" Revisions ");
  expect(graph.borderColor).toEqual(border);
  ui.key("TAB");
  await ui.until("(focused)");
  const footer = (ui.node("shortcuts") as TextRenderable).plainText;
  expect(footer).toContain("half page");
  expect(footer).toContain("Tab back to revisions");
  expect(footer).not.toContain("describe");
}));

test("overlay failures retain complete errors and the full-error key respects overrides", () => withUiFixture("retained-error", async ui => {
  ui.key("L");
  ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  await ui.type("foo("); ui.key("RETURN");
  await ui.until("Error:");
  const error = (ui.node("action-overlay-feedback") as TextRenderable).plainText;
  expect(error).toContain("foo(");
  ui.key("ESCAPE");
  await ui.until("Empty change.");
  ui.key("x");
  await ui.until("Last error");
  expect(String((ui.node("preview-text") as TextRenderable).content)).toContain("foo(");
  ui.key("ESCAPE");
  await ui.until("Empty change.");
}, { bindings: parseKeybindings({ bindings: { lastError: ["x"], clearSearch: [] } }) }));

test("browse errors show a compact summary and preserve the complete stderr", () => withUiFixture("browse-error", async ui => {
  const error = "First error line " + "long details ".repeat(20) + "\nSecond error line";
  ui.repo.operations = async () => { throw new Error(error); };
  ui.key("u");
  await ui.until("^E full error");
  const summary = (ui.node("message") as TextRenderable).plainText;
  expect(summary).not.toContain("Second error line");
  ui.key("e", { ctrl: true });
  await ui.until("Last error");
  expect(String((ui.node("preview-text") as TextRenderable).content)).toContain(error);
  ui.key("d");
  await ui.until("Empty change.");
}));
