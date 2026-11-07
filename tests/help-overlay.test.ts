import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";
import type { TextRenderable } from "@opentui/core";
import { parseKeybindings } from "../src/ui/keybindings";

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

// The overlay's scroll area used to size itself from its content and then shrink for the scrollbar, leaving each
// description a fraction of a cell too wide. Yoga rounds text up and OpenTUI measures it rounded down, so text ran into
// the padding and a description that exactly fit was measured as two lines, drawing a blank line beneath it.
for (const [width, height] of [[80, 24], [90, 30], [100, 30]]) {
  test(`help descriptions fit their rows at ${width}x${height}`, () => withUiFixture(`help-fit-${width}`, async ui => {
    await ui.until("Empty change.");
    ui.key("?");
    await ui.until("Navigate");
    const rows = ui.node("help").getChildren().filter(row => row.getChildren().length === 2);
    expect(rows.length).toBeGreaterThan(0);
    const overflowing = rows.flatMap(row => {
      const [key, text] = row.getChildren();
      return text!.width > row.width - key!.width ? [`${(key as TextRenderable).plainText}: ${text!.width} > ${row.width - key!.width}`] : [];
    });
    expect(overflowing).toEqual([]);
  }, { width, height }));
}
