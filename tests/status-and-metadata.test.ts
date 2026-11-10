import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";

test("a finished action is reported once, in the message slot, without moving the graph", () => withUiFixture("status-slot", async ui => {
  await ui.until("Empty change.");
  const firstRow = () => ui.screen.captureCharFrame().split("\n")[ui.node("revision-pane").screenY + 1];
  const [parent] = (await ui.repo.snapshot("@")).revisions;
  const before = ui.node("revisions").screenY;
  ui.key("n");
  await ui.until(`Created a new change on ${parent!.changeId.slice(0, 8)}.`);
  await ui.settled();
  expect(ui.node("revisions").screenY).toBe(before);
  expect(firstRow()).toContain("@");
  expect(ui.screen.captureCharFrame()).not.toContain("completed");
  ui.key("u");
  await ui.until("Undo preview");
  // The operation is named by a short ID and when it ran, not its 128-character ID and timestamp range.
  const review = ui.screen.captureCharFrame();
  expect(review).toMatch(/[0-9a-f]{12} .*(now|ago)/);
  expect(review).not.toMatch(/[0-9a-f]{64}/);
  ui.key("RETURN");
  await ui.until("Undid the last operation.");
  expect(ui.node("revisions").screenY).toBe(before);
}, { theme: "dark" }), 15_000);

test("operation history shows how long ago each operation ran", () => withUiFixture("operation-times", async ui => {
  await ui.until("Empty change.");
  ui.key("o");
  await ui.until("Operation history");
  const frame = ui.screen.captureCharFrame();
  expect(frame).toMatch(/[0-9a-f]{12} (now|\d+ \w+ ago)/);
  expect(frame).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
}, { theme: "dark" }), 15_000);

test("the preview's metadata labels share one column", () => withUiFixture("metadata-column", async ui => {
  await ui.until("Empty change.");
  const lines = ui.screen.captureCharFrame().split("\n");
  const column = (label: string) => {
    const line = lines.find(text => text.includes(`│${label} `))!;
    const start = line.indexOf(`│${label}`) + 1;
    return start + line.slice(start).search(/ \S/) + 1;
  };
  const values = ["Change", "Commit", "Author", "Bookmarks", "Parents"].map(column);
  expect(new Set(values).size).toBe(1);
}, { theme: "dark" }), 15_000);

// jj names an undone operation by its full 128-character ID in the undo's own description.
test("undoing an undo names the operation by a short ID", () => withUiFixture("undo-of-undo", async ui => {
  await ui.until("Empty change.");
  ui.key("n");
  await ui.until("Created a new change");
  await ui.settled();
  for (const done of ["Undid the last operation.", "Undid the last operation."]) {
    ui.key("u");
    await ui.until("Undo preview");
    expect(ui.screen.captureCharFrame()).not.toMatch(/[0-9a-f]{64}/);
    ui.key("RETURN");
    await ui.until(done);
    await ui.settled();
  }
  ui.key("o");
  await ui.until("Operation history");
  expect(ui.screen.captureCharFrame()).toMatch(/(revert|undo) operation [0-9a-f]{12}\b/);
}, { theme: "dark" }), 15_000);

// At 80 columns the message shares the revset row. A long success message is cut; the revset keeps its room.
test("a long success message gives way to the revset at 80 columns", () => withUiFixture("message-fit", async ui => {
  await ui.until("Empty change.");
  ui.key("B");
  await ui.until("bookmark name");
  await ui.type("a-really-long-bookmark-name-that-goes-on-and-on");
  ui.key("RETURN");
  await ui.until("Created bookmark");
  await ui.settled();
  const row = ui.screen.captureCharFrame().split("\n")[1] ?? "";
  expect(row).toContain("revset: builtin_log()  ·  3 revisions");
  expect(row).toContain("Created bookmark a-really");
  expect(row.trimEnd()).toMatch(/…$/);
}, { theme: "dark", width: 80, height: 24 }), 15_000);
