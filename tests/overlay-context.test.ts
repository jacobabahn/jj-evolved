import { expect, test } from "bun:test";
import { withUiFixture, type UiFixture } from "../tooling/ui";

const overlayText = (ui: UiFixture) => {
  const box = ui.node("action-overlay");
  return ui.screen.captureCharFrame().split("\n").slice(box.screenY, box.screenY + box.height)
    .map(line => Array.from(line).slice(box.screenX, box.screenX + box.width).join("")).join("\n");
};

async function closed(ui: UiFixture) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { ui.node("action-overlay"); } catch { return; }
    await ui.settled();
    await Bun.sleep(10);
  }
  throw new Error("The overlay did not close");
}

// The selected revision is shown above an overlay only when it is what the overlay acts on.
test("overlays show the selected revision only when they act on it", () => withUiFixture("overlay-context", async ui => {
  await ui.until("Empty change.");
  ui.key(" ");
  await ui.until("── Edit ──");
  expect(overlayText(ui)).toContain("Source ");
  ui.key("ESCAPE");
  await closed(ui);
  // Bookmarks and operation history leave it out, and so do the levels opened from them.
  ui.key("b");
  await ui.until("Git remotes");
  expect(overlayText(ui)).not.toContain("Source ");
  ui.key("ESCAPE");
  await closed(ui);
  ui.key("o");
  await ui.until("─ Operation history");
  ui.key("RETURN");
  await ui.until("Restore this operation");
  expect(overlayText(ui)).not.toContain("Source ");
  ui.key("ESCAPE");
  await ui.until("─ Operation history");
  expect(overlayText(ui)).not.toContain("Source ");
  ui.key("ESCAPE");
  await closed(ui);
  for (const [key, title] of [["L", "Revset"], ["RETURN", "Describe"]] as const) {
    await ui.until("Empty change.");
    ui.key(key);
    await ui.until(`─ ${title}`);
    await ui.settled();
    expect({ title, text: overlayText(ui) }).toEqual({ title, text: expect.not.stringContaining("Source ") });
    ui.key("ESCAPE");
    await closed(ui);
  }
}, { theme: "dark" }), 15_000);
