import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";

// Below 100 columns the side margins would leave slivers of the panes beside the overlay, so it spans the screen.
for (const [width, height, left] of [[80, 24, 0], [99, 30, 0], [100, 30, 8], [120, 40, 10]] as const) {
  test(`overlays at ${width}x${height} start at column ${left}`, () => withUiFixture(`overlay-width-${width}`, async ui => {
    await ui.until("Empty change.");
    ui.key("?");
    await ui.until("Help · ");
    const box = ui.node("action-overlay");
    expect({ x: box.screenX, width: box.width }).toEqual({ x: left, width: width - 2 * left });
  }, { theme: "dark", width, height }), 15_000);
}

test("help and the review before applying draw no box inside the overlay's", () => withUiFixture("overlay-depth", async ui => {
  await ui.until("Empty change.");
  const preview = () => ui.node("overlay-preview") as ScrollBoxRenderable;
  ui.key("?");
  await ui.until("Help · ");
  expect(preview().border).toBe(false);
  ui.key("ESCAPE");
  await ui.until("─ Revisions ─");
  ui.key("r");
  await ui.until("Rebase from");
  ui.key("j");
  ui.key("RETURN");
  await ui.until("Review before applying · Rebase preview");
  expect(preview().border).toBe(false);
  expect(ui.screen.captureCharFrame()).toContain("Current tree");
  // Pickers keep the bordered Selection pane.
  ui.key("ESCAPE");
  await ui.until("Rebase from");
  ui.key("ESCAPE");
  await ui.until("─ Revisions ─");
  ui.key("o");
  await ui.until("Selection");
  expect(preview().border).toBe(true);
}, { theme: "dark" }), 15_000);
