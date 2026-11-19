import { expect, test } from "bun:test";
import { rm, rename } from "node:fs/promises";
import { join } from "node:path";
import type { TextRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";
import { markGlyph, type FileList } from "../src/revisions/file-list";

type Ui = Parameters<Parameters<typeof withUiFixture>[1]>[0];
const footer = (ui: Ui) => (ui.node("shortcuts") as TextRenderable).plainText;
const files = (ui: Ui) => ui.node("changed-files") as unknown as FileList;
const frame = async (ui: Ui) => { await ui.screen.renderOnce(); return ui.screen.captureCharFrame(); };
const visibleRows = (ui: Ui) => files(ui).getChildren().filter(row => row.visible && row.id.includes("-row-")).map(row => (row as TextRenderable).plainText);

// Moves the highlight to `path` with the down and up keys, as a user would.
async function highlight(ui: Ui, path: string) {
  for (const key of ["k", "j"]) {
    for (let step = 0; step < 20 && files(ui).selectedFile?.path !== path; step++) {
      const before = files(ui).getSelectedIndex();
      ui.key(key);
      await ui.settled();
      if (files(ui).getSelectedIndex() === before) break;
    }
  }
  expect(files(ui).selectedFile?.path).toBe(path);
}
async function filterBy(ui: Ui, text: string) {
  ui.key("/");
  await ui.until("Enter keep filter");
  ui.key("u", { ctrl: true });
  await ui.type(text);
  ui.key("RETURN");
  await ui.settled();
}

// The working copy holds paths with spaces and wildcard characters, a rename and a deletion.
const tricky = {
  prepare: async (f: { path: string; jj(...args: string[]): Promise<string> }) => {
    await Bun.write(join(f.path, "gone.txt"), "soon removed\n");
    await f.jj("new", "-m", "Tricky paths");
    await rm(join(f.path, "gone.txt"));
    await rename(join(f.path, "hello.txt"), join(f.path, "moved [v1].txt"));
    for (const name of ["a b.txt", "star*.txt", "q?.txt", "[x].txt"]) await Bun.write(join(f.path, name), `${name}\n`);
  },
};

test("marks survive filtering by literal text, and leaving clears the filter before collapsing", () => withUiFixture("file-marks-filter", async ui => {
  await ui.until("Ready.");
  ui.key("l");
  await ui.until("star*.txt");
  const all = ["[x].txt", "a b.txt", "gone.txt", "moved [v1].txt", "q?.txt", "star*.txt"];
  expect(visibleRows(ui).map(row => row.trim().replace(/^.*?[ADMR] /, ""))).toEqual(all);
  expect(visibleRows(ui).find(row => row.endsWith("gone.txt"))).toContain("D gone.txt");
  expect(visibleRows(ui).find(row => row.endsWith("moved [v1].txt"))).toContain("R moved [v1].txt");
  // With nothing marked, actions target the highlighted file.
  expect(files(ui).targets()).toEqual({ paths: ["[x].txt"], label: "highlighted file" });
  expect(footer(ui)).toContain("Space select");
  expect(footer(ui)).toContain("m actions · highlighted file");

  // Mark a renamed file, a deleted one, and paths with a space and a wildcard, out of list order.
  for (const path of ["star*.txt", "a b.txt", "moved [v1].txt", "gone.txt"]) { await highlight(ui, path); ui.key(" "); await ui.settled(); }
  const marked = ["a b.txt", "gone.txt", "moved [v1].txt", "star*.txt"];
  expect(files(ui).markedPaths).toEqual(marked);
  expect(files(ui).targets()).toEqual({ paths: marked, label: "4 selected" });
  expect(footer(ui)).toContain("m actions · 4 selected");
  expect(footer(ui)).toContain("c clear");
  for (const path of marked) expect(visibleRows(ui).find(row => row.endsWith(` ${path}`))).toContain(`${markGlyph} `);
  expect(visibleRows(ui).find(row => row.endsWith(" q?.txt"))).not.toContain(markGlyph);
  // Space again unmarks the highlighted file.
  ui.key(" "); await ui.settled();
  expect(files(ui).markedPaths).toEqual(["a b.txt", "moved [v1].txt", "star*.txt"]);
  ui.key(" "); await ui.settled();

  // Wildcard characters are literal text: * matches only the path containing a star.
  ui.key("/");
  await ui.until("Enter keep filter");
  await ui.type("*");
  await ui.until("1 of 6 files");
  expect(visibleRows(ui)).toHaveLength(1);
  ui.key("RETURN");
  await ui.until("/*  1 of 6 files");
  expect(visibleRows(ui)[0]).toContain(`${markGlyph} A star*.txt`);
  expect(files(ui).selectedFile?.path).toBe("star*.txt");
  await ui.until("── star*.txt ──");
  // Hidden marks still count and still target, in list order.
  expect(files(ui).targets()).toEqual({ paths: marked, label: "4 selected" });
  expect(footer(ui)).toContain("Esc/h/l clear filter");

  await filterBy(ui, "?");
  expect(visibleRows(ui).map(row => row.trim().slice(-6))).toEqual(["q?.txt"]);
  await filterBy(ui, "[");
  expect(visibleRows(ui).map(row => row.replace(/^.*?[ADMR] /, ""))).toEqual(["[x].txt", "moved [v1].txt"]);
  // Case is ignored, and a space is part of the text.
  await filterBy(ui, "A B");
  expect(visibleRows(ui).map(row => row.replace(/^.*?[ADMR] /, ""))).toEqual(["a b.txt"]);
  // Marking under a filter adds to the hidden marks.
  ui.key(" "); await ui.settled();
  expect(files(ui).markedPaths).toEqual(["gone.txt", "moved [v1].txt", "star*.txt"]);
  ui.key(" "); await ui.settled();
  expect(files(ui).markedPaths).toEqual(marked);

  // A filter that hides every file says so, and nothing is highlighted.
  await filterBy(ui, "nothing like this");
  await ui.until("0 of 6 files");
  await ui.until('No changed files match "nothing like this".');
  expect(files(ui).targets()).toEqual({ paths: marked, label: "4 selected" });
  // Escape while typing puts back the filter from before.
  ui.key("/");
  await ui.until("Enter keep filter");
  await ui.type("x");
  await ui.until("0 of 6 files");
  ui.key("ESCAPE");
  await ui.until('/nothing like this  0 of 6 files');

  // Escape, h and Left each clear the filter first, with every mark still in place.
  for (const key of ["ESCAPE", "h", "ARROW_LEFT"]) {
    await filterBy(ui, "star");
    expect(visibleRows(ui)).toHaveLength(1);
    ui.key(key);
    // A lone Escape reaches the app after the terminal parser's escape delay.
    if (key === "ESCAPE") await Bun.sleep(60);
    await ui.settled();
    expect(visibleRows(ui)).toHaveLength(6);
    expect(await frame(ui)).not.toContain("of 6 files");
    expect(files(ui).markedPaths).toEqual(marked);
    expect(footer(ui)).toContain("collapse");
  }
  // With no filter, the next press collapses.
  ui.key("h");
  await ui.until("Change preview");
  expect(ui.screen.renderer.root.findDescendantById("changed-files")).toBeUndefined();
  // Opening the browser again starts with no marks and no filter.
  ui.key("l");
  await ui.until("star*.txt");
  expect(files(ui).markedPaths).toEqual([]);
  expect(files(ui).filter).toBe("");
}, tricky), 30_000);

test("clearing marks, and a refresh keeps marks on files still in the change and reports the dropped ones", () => withUiFixture("file-marks-refresh", async ui => {
  await ui.until("Ready.");
  ui.key("l");
  await ui.until("star*.txt");
  for (const path of ["a b.txt", "q?.txt", "star*.txt", "[x].txt"]) { await highlight(ui, path); ui.key(" "); await ui.settled(); }
  ui.key("c");
  await ui.until("Unselected 4 files.");
  expect(files(ui).markedPaths).toEqual([]);
  expect(footer(ui)).not.toContain("selected");
  ui.key("c");
  await ui.until("No files are selected.");

  for (const path of ["a b.txt", "q?.txt", "star*.txt"]) { await highlight(ui, path); ui.key(" "); await ui.settled(); }
  await highlight(ui, "q?.txt");
  await filterBy(ui, ".txt");
  // An edit elsewhere rewrites the change: the marks and the filter stay.
  await Bun.write(join(ui.f.path, "a b.txt"), "edited elsewhere\n");
  await Bun.write(join(ui.f.path, "new*.txt"), "late arrival\n");
  await ui.app!.checkForUpdates();
  await ui.until("new*.txt");
  expect(files(ui).markedPaths).toEqual(["a b.txt", "q?.txt", "star*.txt"]);
  expect(files(ui).selectedFile?.path).toBe("q?.txt");
  expect(files(ui).filter).toBe(".txt");
  await ui.until("/.txt  7 of 7 files");
  expect(visibleRows(ui).find(row => row.endsWith(" new*.txt"))).not.toContain(markGlyph);
  // A marked file that leaves the change loses its mark, and the status line says so.
  await rm(join(ui.f.path, "star*.txt"));
  await ui.app!.checkForUpdates();
  await ui.until("1 selected file left the change.");
  expect(files(ui).markedPaths).toEqual(["a b.txt", "q?.txt"]);
  expect(footer(ui)).toContain("2 selected");
  expect(files(ui).targets()).toEqual({ paths: ["a b.txt", "q?.txt"], label: "2 selected" });
}, tricky), 30_000);
