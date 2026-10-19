import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";
import { parseKeybindings } from "../src/ui/keybindings";
import type { BoxRenderable, TextRenderable } from "@opentui/core";

test("inline mode restores its pane, confirmation removes duplicate chrome, and focus changes hints", () => withUiFixture("mode-signals", async ui => {
  const graph = ui.node("revision-pane") as BoxRenderable;
  const border = graph.borderColor;
  ui.key("r");
  await ui.until("Rebase: choose destination");
  expect(graph.borderColor).not.toEqual(border);
  ui.key("j"); ui.key("j"); ui.key("RETURN");
  await ui.until("Rebase preview");
  expect(ui.screen.renderer.root.findDescendantById("prompt-label")?.visible).toBe(false);
  expect(ui.screen.renderer.root.findDescendantById("action-overlay-feedback")?.visible).toBe(false);
  expect(ui.screen.captureCharFrame()).not.toContain("Ready.");
  ui.key("ESCAPE");
  await ui.until("Rebase: choose destination");
  ui.key("ESCAPE");
  await ui.until("Cancelled.");
  expect(graph.title).toBe(" Revisions ");
  expect(graph.borderColor).toEqual(border);
  ui.key("TAB");
  await ui.until("(focused)");
  const footer = (ui.node("shortcuts") as TextRenderable).plainText;
  expect(footer).toContain("half page");
  expect(footer).toContain("Tab back to revisions");
  expect(footer).not.toContain("describe");
}));

test("overlay failures retain complete errors and the full-error key respects overrides", () => withUiFixture("retained-error", async ui => {
  ui.key("L");
  ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  await ui.type("foo("); ui.key("RETURN");
  await ui.until("Error:");
  const error = (ui.node("action-overlay-feedback") as TextRenderable).plainText;
  expect(error).toContain("foo(");
  ui.key("ESCAPE");
  await ui.until("Empty change.");
  ui.key("x");
  await ui.until("Last error");
  expect(String((ui.node("preview-text") as TextRenderable).content)).toContain("foo(");
  ui.key("ESCAPE");
  await ui.until("Empty change.");
}, { bindings: parseKeybindings({ bindings: { lastError: ["x"], clearSearch: [] } }) }));

test("browse errors show a compact summary and preserve the complete stderr", () => withUiFixture("browse-error", async ui => {
  const error = "First error line " + "long details ".repeat(20) + "\nSecond error line";
  ui.repo.operations = async () => { throw new Error(error); };
  ui.key("u");
  await ui.until("^E full error");
  const summary = (ui.node("message") as TextRenderable).plainText;
  expect(summary).not.toContain("Second error line");
  ui.key("e", { ctrl: true });
  await ui.until("Last error");
  expect(String((ui.node("preview-text") as TextRenderable).content)).toContain(error);
  ui.key("d");
  await ui.until("Empty change.");
}));

const footer = (ui: Parameters<Parameters<typeof withUiFixture>[1]>[0]) => (ui.node("shortcuts") as TextRenderable).plainText;

test("prompts and overlays put their own keys in the footer instead of the browse keys", () => withUiFixture("footer-modes", async ui => {
  await ui.until("Ready.");
  expect(footer(ui)).toContain("Space actions");
  expect(footer(ui)).toContain("Tab focus preview");
  expect(footer(ui)).not.toContain("match");
  ui.key("?");
  await ui.until("Keyboard reference");
  expect(footer(ui)).toContain("j/k scroll  PgDn/PgUp page");
  expect(footer(ui)).toContain("Esc/? close");
  expect(footer(ui)).not.toContain("describe");
  ui.key("ESCAPE");
  await ui.until("Tab focus preview");
  ui.key(" ");
  await ui.until("── Edit ──");
  expect(footer(ui)).toContain("j/k choose  Enter select  / filter");
  expect(footer(ui)).toContain("Esc close");
  ui.key("/");
  await ui.settled();
  expect(footer(ui)).toContain("Esc clear");
  ui.key("ESCAPE");
  await ui.until("Esc close");
  ui.key("ESCAPE");
  await ui.until("Tab focus preview");
  ui.key("r");
  await ui.until("Rebase: choose destination");
  expect(footer(ui)).toContain("j/k destination  Tab descendants  Enter preview");
  expect(footer(ui)).toMatch(/Esc cancel\s*$/);
  expect(ui.screen.captureCharFrame()).not.toContain("will move");
  ui.key("ESCAPE");
  await ui.until("Cancelled.");
  ui.key("L");
  await ui.until("Revset");
  expect(footer(ui)).toContain("Enter apply  Tab/Shift-Tab complete");
  expect(ui.screen.captureCharFrame()).not.toContain("[Enter apply");
}, { width: 80, height: 24 }));

test("the files view footer pins help and opening help keeps the files expanded", () => withUiFixture("footer-files", async ui => {
  await ui.until("Ready.");
  ui.key("l");
  await ui.until("files of");
  expect(footer(ui)).toContain("Enter focus diff  Tab focus preview");
  expect(footer(ui)).toContain("Esc/l collapse");
  expect(footer(ui)).toMatch(/\? help  q quit\s*$/);
  ui.key("?");
  await ui.until("Keyboard reference");
  ui.key("ESCAPE");
  await ui.until("Enter focus diff");
  expect(ui.screen.captureCharFrame()).toContain("files of");
}, { width: 80, height: 24 }));

test("help opened from the files view during a refresh returns to up-to-date files", () => withUiFixture("footer-files-refresh", async ui => {
  await ui.until("Ready.");
  ui.key("j");
  await ui.until("Initial feature");
  ui.key("l");
  await ui.until("hello from jj-evolved");
  // Let the files view's own preview load finish first, so only the focus refresh is in flight.
  await Bun.sleep(500);
  await ui.settled();
  await ui.f.jj("describe", "-r", "@-", "-m", "Initial feature reworded");
  // The focus refresh starts before help opens, so it lands while help covers the files.
  ui.screen.renderer.emit("focus");
  await Promise.resolve();
  ui.key("?");
  await ui.until("Keyboard reference");
  // Help hides the graph, so give the refresh time to land underneath it.
  await Bun.sleep(1500);
  await ui.settled();
  ui.key("ESCAPE");
  await Bun.sleep(1500);
  await ui.settled();
  const frame = ui.screen.captureCharFrame();
  expect(frame).toContain("Initial feature reworded");
  expect(frame).toContain("▾");
  expect(frame).toContain("A hello.txt");
  expect(frame).toContain("hello from jj-evolved");
  expect(footer(ui)).toContain("j/k file");
}));

test("searches inside pickers and the history form switch the footer to the search keys", () => withUiFixture("footer-search-keys", async ui => {
  await ui.until("Ready.");
  ui.key("r");
  await ui.until("Rebase: choose destination");
  ui.key("/");
  // Opened from outside a key handler, the search still repaints the footer straight away.
  await ui.until("^N/^P choose");
  expect(footer(ui)).toMatch(/Esc clear\s*$/);
  ui.key("ESCAPE");
  await ui.until("/ search all destinations");
  ui.key("ESCAPE");
  await ui.until("Rebase: choose destination");
  ui.key("ESCAPE");
  await ui.until("Cancelled.");
  ui.key(" ");
  await ui.until("── Edit ──");
  ui.choose("Rebase");
  await ui.until("Destination:");
  await ui.until("Enter edit/apply");
  ui.key("RETURN");
  await ui.until("/ search all destinations");
  ui.key("/");
  await ui.until("^N/^P choose");
  ui.key("ESCAPE");
  await ui.until("/ search all destinations");
}));

test("footers follow the legacy preset, unbound keys and the terminal width", async () => {
  const legacy = parseKeybindings({ preset: "legacy", bindings: { files: [], up: [] } });
  await withUiFixture("footer-bindings", async ui => {
    await ui.until("Ready.");
    expect(footer(ui)).toContain("j move  / revset  ^F search");
    expect(footer(ui)).toContain("d describe  Enter diff");
    ui.key(" ");
    await ui.until("── Edit ──");
    ui.choose("Browse changed files");
    await ui.until("files of");
    // With files unbound, the collapse hint keeps the key that still works.
    expect(footer(ui)).toMatch(/^Esc collapse /m);
    await ui.resize(60, 24);
    await ui.settled();
    for (const line of footer(ui).split("\n")) expect(line.trimEnd().length).toBeLessThanOrEqual(60);
    expect(footer(ui)).toMatch(/\? help  q quit\s*$/);
    await ui.resize(140, 24);
    await ui.until("PgDn/PgUp scroll diff  p hide preview");
  }, { width: 80, height: 24, bindings: legacy });
});
