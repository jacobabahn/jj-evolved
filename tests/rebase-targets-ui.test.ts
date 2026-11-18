import { expect, test } from "bun:test";
import type { SelectRenderable, TextRenderable } from "@opentui/core";
import { withUiFixture, type UiFixture } from "../tooling/ui";
import type { Revision } from "../src/repository/model";

// Feature (Initial feature) has children B and X; B is a branch point with children C and D. X, the working copy, moves.
async function stack(f: { jj(...args: string[]): Promise<string> }) {
  await f.jj("describe", "-m", "B");
  await f.jj("new", "-m", "C");
  await f.jj("new", "-m", "D", "description(exact:'B\n')");
  await f.jj("new", "-m", "X", "feature");
}

async function revision(ui: UiFixture, name: string): Promise<Revision> {
  const item = (await ui.repo.snapshot(`description(exact:${JSON.stringify(name + "\n")})`)).revisions[0];
  if (!item) throw new Error(`Missing revision: ${name}`);
  return item;
}

/** Each revision's parents, by description. */
async function parents(ui: UiFixture): Promise<Record<string, string>> {
  const out = await ui.f.jj("log", "--no-graph", "-r", "all() ~ root()", "-T",
    'description.first_line() ++ ":" ++ parents.map(|p| coalesce(p.description().first_line(), "root")).join(",") ++ "\\n"');
  return Object.fromEntries(out.trim().split("\n").map(line => line.split(":") as [string, string]));
}

/** Moves the graph's cursor onto a revision. */
async function cursorTo(ui: UiFixture, target: Revision) {
  const log = ui.node("revisions") as unknown as { revisions: Revision[]; getSelectedIndex(): number };
  const index = log.revisions.findIndex(item => item.commitId === target.commitId);
  if (index < 0) throw new Error(`Not in the graph: ${target.description}`);
  for (let at = log.getSelectedIndex(); at !== index; at += at < index ? 1 : -1) ui.key(at < index ? "j" : "k");
  await ui.settled();
}

const hint = (ui: UiFixture) => (ui.node("inline-action") as TextRenderable).plainText;
const footer = (ui: UiFixture) => (ui.node("shortcuts") as TextRenderable).plainText;
const id = (item: Revision) => item.changeId.slice(0, 8);

test("inline between rebase keeps its target and scope in view and corrects either boundary", () => withUiFixture("rebase-between-inline", async ui => {
  await ui.until("Empty change.");
  const [b, c, d] = [await revision(ui, "B"), await revision(ui, "C"), await revision(ui, "D")];
  ui.key("r");
  await ui.until("Rebase: choose destination");
  ui.key("TAB");
  await ui.until("[x] include descendants");
  ui.key("m");
  await ui.until("Rebase: insert before");
  expect(footer(ui)).toContain("m target: before");
  ui.key("m"); ui.key("m");
  await ui.until("Rebase between: after");
  // Switching the target keeps the scope.
  expect(hint(ui)).toContain("[x] include descendants");
  expect(hint(ui)).toContain("target: between two revisions");
  expect(footer(ui)).toContain("Enter next boundary");
  // The first boundary is picked wrong, then corrected from the second.
  await cursorTo(ui, d);
  ui.key("RETURN");
  await ui.until("Rebase between: before");
  expect(hint(ui)).toContain(`after ${id(d)}, before`);
  expect(footer(ui)).toContain("Esc back to after");
  ui.key("ESCAPE");
  await ui.until("Rebase between: after");
  await cursorTo(ui, b);
  ui.key("RETURN");
  await ui.until(`after ${id(b)}, before`);
  await cursorTo(ui, d);
  ui.key("RETURN");
  await ui.until("Rebase preview · between two revisions");
  expect(ui.screen.captureCharFrame()).toContain("Target: between two revisions");
  // Back from the review to the second boundary, which is corrected; the first stays.
  ui.key("ESCAPE");
  await ui.until("Rebase between: before");
  expect(hint(ui)).toContain(`after ${id(b)}, before ${id(d)}`);
  expect(hint(ui)).toContain("[x] include descendants");
  await cursorTo(ui, c);
  ui.key("RETURN");
  await ui.until("Rebase preview · between two revisions");
  expect(await parents(ui)).toMatchObject({ X: "Initial feature", C: "B", D: "B" });
  ui.key("RETURN");
  await ui.until(`between ${id(b)} and`);
  expect(await parents(ui)).toMatchObject({ X: "B", C: "X", D: "B" });
}, { prepare: stack }), 20_000);

test("inline after rebase previews the moving descendants, and cancelling changes nothing", () => withUiFixture("rebase-after-cancel", async ui => {
  await ui.until("Empty change.");
  const b = await revision(ui, "B");
  const operation = await ui.repo.operationId();
  ui.key("r");
  await ui.until("Rebase: choose destination");
  ui.key("m"); ui.key("m");
  await ui.until("Rebase: insert after");
  await cursorTo(ui, b);
  expect(hint(ui)).toContain(`→ insert after ${id(b)}`);
  ui.key("RETURN");
  await ui.until("Rebase preview · insert after");
  // The review lists the destination's descendants that move with the insert.
  const summary = (ui.node("overlay-preview-text") as unknown as { content: string }).content;
  expect(summary).toContain(`Target: insert after ${id(b)}`);
  expect(summary).toContain(`Descendants of ${id(b)} also move onto the rebased changes (2)`);
  ui.key("ESCAPE");
  await ui.until("Rebase: insert after");
  ui.key("ESCAPE");
  await ui.until("Cancelled.");
  expect(await ui.repo.operationId()).toBe(operation);
  expect(await parents(ui)).toMatchObject({ X: "Initial feature", C: "B", D: "B" });
}, { prepare: stack }), 20_000);

test("inline between rebase that jj rejects shows jj's error and keeps the draft", () => withUiFixture("rebase-between-rejected", async ui => {
  await ui.until("Empty change.");
  const [b, c] = [await revision(ui, "B"), await revision(ui, "C")];
  const operation = await ui.repo.operationId();
  ui.key("r");
  await ui.until("Rebase: choose destination");
  ui.key("TAB");
  ui.key("m"); ui.key("m"); ui.key("m");
  await ui.until("Rebase between: after");
  // After C but before its ancestor B is a cycle.
  await cursorTo(ui, c);
  ui.key("RETURN");
  await ui.until(`after ${id(c)}, before`);
  await cursorTo(ui, b);
  ui.key("RETURN");
  await ui.until("Refusing to create a loop");
  expect(hint(ui)).toContain(`after ${id(c)}, before ${id(b)}`);
  expect(hint(ui)).toContain("[x] include descendants");
  expect(await ui.repo.operationId()).toBe(operation);
}, { prepare: stack }), 20_000);

/** Moves the form's cursor onto the row that starts with `row`. */
function fieldTo(ui: UiFixture, row: string) {
  const fields = ui.node("history-fields") as SelectRenderable;
  const index = fields.options.findIndex(option => option.name.startsWith(row));
  if (index < 0) throw new Error(`No form row ${row}`);
  for (let at = fields.getSelectedIndex(); at !== index; at += at < index ? 1 : -1) ui.key(at < index ? "j" : "k");
}

async function chooseBoundary(ui: UiFixture, row: string, target: Revision) {
  fieldTo(ui, `${row}:`);
  ui.key("RETURN");
  await ui.until("/ search all destinations");
  ui.key("/"); await ui.type(target.changeId);
  await ui.settled();
  ui.key("RETURN");
  await ui.until(`${row}: ${id(target)}`);
}

test("the rebase form switches target without losing the scope and corrects either between boundary", () => withUiFixture("rebase-between-form", async ui => {
  await ui.until("Empty change.");
  const [feature, b, c, d] = [await revision(ui, "Initial feature"), await revision(ui, "B"), await revision(ui, "C"), await revision(ui, "D")];
  const fields = () => (ui.node("history-fields") as SelectRenderable).options.map(option => option.name);
  ui.key(" "); ui.choose("Rebase");
  await ui.until("Destination: Choose a revision");
  expect(fields()[0]).toBe("Target: Onto");
  // Turn on descendants, then pick a destination for onto.
  ui.key("j"); ui.key("RETURN");
  await ui.until("Scope: Change and descendants");
  await ui.until("Choose a destination first.");
  await chooseBoundary(ui, "Destination", b);
  await ui.until("Preview ready");
  // Switching target keeps the scope and the destination, and asks for a fresh preview.
  ui.key("m");
  await ui.until("Target: Insert before");
  expect(fields()).toContain(`Insert before: ${id(b)} B`);
  ui.key("m"); ui.key("m");
  await ui.until("Target: Between two revisions");
  await ui.until("Choose the revision to insert before.");
  expect(fields()).toEqual(["Target: Between two revisions", `After: ${id(b)} B`, "Before: Choose a revision", expect.stringContaining("Scope: Change and descendants"), "Apply rebase"]);
  // A rejected pair shows jj's error and keeps both boundaries.
  await chooseBoundary(ui, "After", c);
  await chooseBoundary(ui, "Before", b);
  await ui.until("Refusing to create a loop");
  expect(fields()).toEqual(["Target: Between two revisions", `After: ${id(c)} C`, `Before: ${id(b)} B`, expect.stringContaining("Scope: Change and descendants"), "Apply rebase"]);
  // Either boundary is corrected on its own.
  await chooseBoundary(ui, "After", feature);
  await chooseBoundary(ui, "Before", d);
  await ui.until("Preview ready");
  await chooseBoundary(ui, "After", b);
  await ui.until("Preview ready");
  expect(fields()[2]).toBe(`Before: ${id(d)} D`);
  expect((ui.node("history-preview-text") as unknown as { content: string }).content).toContain("Target: between two revisions");
  fieldTo(ui, "Apply rebase");
  ui.key("RETURN");
  await ui.until(`between ${id(b)} and`);
  expect(await parents(ui)).toMatchObject({ X: "B", D: "X", C: "B" });
}, { prepare: stack, height: 34 }), 30_000);
