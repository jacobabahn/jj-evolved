import { expect, test } from "bun:test";
import { join } from "node:path";
import { rgbToHex } from "@opentui/core";
import { themes } from "../src/ui/theme";
import { withUiFixture } from "../tooling/ui";

test("the preview marks a conflicted working copy ! conflict in the conflict colour, as the graph does", () => withUiFixture("conflict-marker", async ui => {
  await Bun.write(join(ui.f.path, "hello.txt"), "left\n");
  await ui.f.jj("bookmark", "create", "left", "-r", "@");
  await ui.f.jj("new", "feature", "-m", "Right edit");
  await Bun.write(join(ui.f.path, "hello.txt"), "right\n");
  await ui.f.jj("rebase", "-r", "@", "-d", "left");
  ui.key("r", { ctrl: true });
  await ui.until("Right edit");
  await ui.settled();
  ui.key("@");
  await ui.until("Working copy  ! conflict");
  const spans = ui.screen.captureSpans().lines.flatMap(line => line.spans).filter(span => span.text.includes("! conflict"));
  // One in the graph row, one in the preview.
  expect(spans.length).toBeGreaterThanOrEqual(2);
  for (const span of spans) expect(rgbToHex(span.fg)).toBe(themes.dark.conflict);
  expect(ui.screen.captureCharFrame()).not.toContain("CONFLICT");
}, { theme: "dark", width: 120, height: 30 }), 15_000);

test("the rebase form's destination list cuts long descriptions with …", () => withUiFixture("form-cut", async ui => {
  await ui.f.jj("new", "feature", "-m", "A destination with a description far too long to fit in the rebase form's list at eighty columns");
  await ui.f.jj("new", "-m", "Source");
  ui.key("r", { ctrl: true });
  await ui.until("Source");
  await ui.settled();
  ui.key(" ");
  ui.choose("Rebase");
  await ui.until("Destination: Choose a revision");
  ui.key("RETURN");
  await ui.until("A destination with");
  await ui.settled();
  const line = ui.screen.captureCharFrame().split("\n").find(text => text.includes("A destination with"));
  if (!line) throw new Error(ui.screen.captureCharFrame());
  // Where the cut falls depends on the form's width; the row must end in … at the border.
  expect(line).toMatch(/\S…│$/);
}, { theme: "dark", width: 80, height: 24 }), 15_000);
