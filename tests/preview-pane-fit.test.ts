import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextBufferRenderable, type Renderable } from "@opentui/core";
import { withUiFixture, type UiFixture } from "../tooling/ui";

// Wrapped text in the main preview that ends past its viewport loses its last column under the border.
function overflowing(ui: UiFixture) {
  const preview = ui.node("preview");
  if (!(preview instanceof ScrollBoxRenderable)) throw new Error("preview is not a scroll box");
  const right = preview.viewport.screenX + preview.viewport.width;
  const found: string[] = [];
  let checked = 0;
  const walk = (node: Renderable) => {
    if (!node.visible) return;
    if (node instanceof TextBufferRenderable && node.wrapMode !== "none" && node.width > 0 && node.plainText) {
      checked++;
      if (node.screenX + node.width > right) found.push(`${node.id} ends at ${node.screenX + node.width}, past the viewport at ${right}`);
    }
    for (const child of node.getChildren()) walk(child);
  };
  walk(preview.content);
  expect(checked).toBeGreaterThan(0);
  return found;
}

// The revisions pane was 42% of the terminal, a fractional width at most sizes (33.6 cells at 80 columns), so the
// preview beside it was fractional too and its text was laid out a column wider than the space it had.
for (const [width, height] of [[80, 24], [70, 24], [90, 30], [100, 30], [120, 40]]) {
  test(`preview text fits the preview pane at ${width}x${height}`, () => withUiFixture(`preview-fit-${width}`, async ui => {
    await ui.until("Empty change.");
    expect(overflowing(ui)).toEqual([]);
    ui.key("\t");
    await ui.until("(focused)");
    expect(overflowing(ui)).toEqual([]);
  }, { width, height }));
}

test("preview text still fits after a resize and after hiding and showing the preview", () => withUiFixture("preview-fit-resize", async ui => {
  await ui.until("Empty change.");
  expect(ui.node("revision-pane").width).toBe(42);
  await ui.resize(80, 24);
  await ui.settled();
  expect(ui.node("revision-pane").width).toBe(34);
  expect(overflowing(ui)).toEqual([]);
  ui.key("p");
  await ui.settled();
  await ui.resize(90, 30);
  ui.key("p");
  await ui.settled();
  expect(ui.node("revision-pane").width).toBe(38);
  expect(overflowing(ui)).toEqual([]);
}, { width: 100, height: 30 }));
