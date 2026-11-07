import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";
import { parseKeybindings } from "../src/ui/keybindings";
import { scrollBoxMisfits } from "./scroll-fit";

test("help preserves hidden preview and selection, remapped help closes it, and status escapes", () => withUiFixture("help-state", async ui => {
  await ui.until("Empty change.");
  ui.key("p");
  ui.key("h");
  await ui.until("Help · custom keys");
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

// The overlay's scroll area used to take its width from its content and then share the shrink for the scrollbar with
// the scrollbar itself, leaving text a fraction of a cell wide. Yoga rounds text up and OpenTUI measures it rounded down,
// so descriptions ran into the padding, and one that exactly fit drew a blank line beneath it (^L at 80x24).
for (const [width, height] of [[80, 24], [90, 30], [100, 30]]) {
  test(`help descriptions fit the overlay at ${width}x${height}`, () => withUiFixture(`help-fit-${width}`, async ui => {
    await ui.until("Empty change.");
    ui.key("?");
    await ui.until("Navigate");
    expect(scrollBoxMisfits(ui, "overlay-preview")).toEqual([]);
  }, { width, height }));
}
