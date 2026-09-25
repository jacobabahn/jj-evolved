import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";
import { parseKeybindings } from "../src/ui/keybindings";

test("help preserves hidden preview and selection, remapped help closes it, and status escapes", () => withUiFixture("help-state", async ui => {
  await ui.until("Empty change.");
  ui.key("p");
  ui.key("h");
  await ui.until("Help · keys: custom");
  expect(ui.screen.renderer.root.findDescendantById("preview")?.visible).toBe(false);
  ui.key("j");
  ui.key("h");
  await ui.screen.renderOnce();
  expect(ui.screen.renderer.root.findDescendantById("action-overlay")?.visible).toBe(false);
  expect(ui.screen.renderer.root.findDescendantById("preview")?.visible).toBe(false);
  ui.key("w");
  await ui.until("Working-copy status");
  ui.key("ESCAPE");
  await ui.until("Empty change.");
  expect(ui.screen.captureCharFrame()).not.toContain("Working-copy status");
}, { bindings: parseKeybindings({ bindings: { help: ["h"] } }) }));
