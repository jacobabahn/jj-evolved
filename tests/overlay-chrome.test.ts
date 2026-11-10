import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";

// Below 120 columns the side margins would leave strips of cut-off pane text beside the overlay, so it spans the screen.
// From 120 columns up it is 84% wide, with margins of 8% of the width.
for (const [width, height, left] of [[80, 24, 0], [100, 30, 0], [110, 30, 0], [119, 30, 0], [120, 30, 10], [160, 40, 13]] as const) {
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

test("a review keeps a cut title on a narrow screen and a blank row before its text", () => withUiFixture("overlay-narrow-review", async ui => {
  await ui.until("Empty change.");
  ui.key("u");
  await ui.until("Review before applying");
  const preview = ui.node("overlay-preview") as ScrollBoxRenderable;
  expect(preview.marginTop).toBe(1);
  await ui.resize(40, 16);
  await ui.settled();
  const top = ui.screen.captureCharFrame().split("\n")[ui.node("action-overlay").screenY] ?? "";
  // OpenTUI drops a border title that does not fit, so the overlay cuts it to fit instead.
  expect(top).toMatch(/^┌─ Review before applying.*… ─*┐$/);
}, { theme: "dark" }), 15_000);

test("the rebase form's preview has no box of its own inside the form", () => withUiFixture("overlay-form-depth", async ui => {
  await ui.until("Empty change.");
  ui.key(" ");
  ui.choose("Rebase");
  await ui.until("Destination: Choose a revision");
  const preview = ui.node("history-preview") as ScrollBoxRenderable;
  expect(preview.border).toBe(false);
  expect(preview.marginTop).toBe(1);
}, { theme: "dark" }), 15_000);
