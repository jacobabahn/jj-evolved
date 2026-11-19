import { expect, test } from "bun:test";
import { join } from "node:path";
import type { TextRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";
import type { FileList } from "../src/revisions/file-list";
import type { Revision } from "../src/repository/model";

type Ui = Parameters<Parameters<typeof withUiFixture>[1]>[0];
const footer = (ui: Ui) => (ui.node("shortcuts") as TextRenderable).plainText;
const header = (ui: Ui) => (ui.node("revset") as TextRenderable).plainText;
const files = (ui: Ui) => ui.node("changed-files") as unknown as FileList;
const log = (ui: Ui) => ui.node("revisions") as unknown as { revisions: Revision[]; getSelectedIndex(): number };
const shown = (ui: Ui) => log(ui).revisions.map(revision => revision.description.trim());
const selected = (ui: Ui) => log(ui).revisions[log(ui).getSelectedIndex()]?.description.trim();

// A lone Escape reaches the app after the terminal parser's escape delay.
async function escape(ui: Ui) { ui.key("ESCAPE"); await Bun.sleep(60); await ui.settled(); }
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

// One revision per edit: a file with a space and one with `*` are each added and edited, and so is xy.txt, which the
// glob x*.txt would match. The working copy edits all three, and an empty change on top keeps it off the graph's head.
const edits: [string, Record<string, string>][] = [
  ["Add space file", { "a b.txt": "1" }],
  ["Add star file", { "x*.txt": "1" }],
  ["Add xy file", { "xy.txt": "1" }],
  ["Edit space file", { "a b.txt": "2" }],
  ["Edit star file", { "x*.txt": "2" }],
  ["Edit xy file", { "xy.txt": "2" }],
  ["Edit all three", { "a b.txt": "3", "x*.txt": "3", "xy.txt": "3" }],
];
const history = {
  prepare: async (f: { path: string; jj(...args: string[]): Promise<string> }) => {
    for (const [description, contents] of edits) {
      await f.jj("new", "-m", description);
      for (const [name, text] of Object.entries(contents)) await Bun.write(join(f.path, name), `${text}\n`);
    }
  },
};

test("file history lists exactly the revisions that change a path with a space or a *, and return restores the revset and the browser", () => withUiFixture("file-history", async ui => {
  await ui.until("Ready.");
  const before = header(ui);
  expect(before).toStartWith("revset: ");
  const revsetBefore = before.slice("revset: ".length).split("  ·  ")[0]!;
  expect(shown(ui)).toContain("Edit xy file");
  ui.key("l");
  await ui.until("M xy.txt");
  expect(footer(ui)).toContain("H history");

  await highlight(ui, "x*.txt");
  ui.key("/");
  await ui.type("t");
  ui.key("RETURN");
  await ui.settled();
  ui.key(" ");
  await ui.settled();
  ui.key("H");
  await ui.until('revset: files(root-file:"x*.txt")  ·  3 revisions');
  await ui.until("^O goes back.");
  // `*` is part of the name: neither xy.txt revision is listed, as they would be if it were a glob.
  expect(header(ui)).toStartWith('revset: files(root-file:"x*.txt")  ·  3 revisions');
  expect(shown(ui)).toEqual(["Edit all three", "Edit star file", "Add star file"]);
  expect(selected(ui)).toBe("Edit all three");
  expect(footer(ui)).toContain("revset");
  expect(footer(ui)).toContain("return");

  // Return puts back the revset, and the browser with its filter, selection and highlight.
  ui.key("o", { ctrl: true });
  await ui.until("m actions · 1 selected");
  expect(header(ui)).toStartWith(`revset: ${revsetBefore}  ·  `);
  expect(shown(ui)).toContain("Edit xy file");
  expect({ filter: files(ui).filter, marked: files(ui).markedPaths, highlighted: files(ui).selectedFile?.path })
    .toEqual({ filter: "t", marked: ["x*.txt"], highlighted: "x*.txt" });

  // A path with a space, then a history opened from within it, each return stepping back one history.
  await escape(ui);
  expect(files(ui).filter).toBe("");
  await highlight(ui, "a b.txt");
  ui.key("H");
  await ui.until('revset: files(root-file:"a b.txt")  ·  3 revisions');
  expect(header(ui)).toStartWith('revset: files(root-file:"a b.txt")  ·  3 revisions');
  expect(shown(ui)).toEqual(["Edit all three", "Edit space file", "Add space file"]);
  ui.key("l");
  await ui.until("M xy.txt");
  await highlight(ui, "xy.txt");
  ui.key("H");
  await ui.until('revset: files(root-file:"xy.txt")  ·  3 revisions');
  expect(shown(ui)).toEqual(["Edit all three", "Edit xy file", "Add xy file"]);
  ui.key("o", { ctrl: true });
  await ui.until("M xy.txt");
  expect(header(ui)).toStartWith('revset: files(root-file:"a b.txt")  ·  3 revisions');
  expect(files(ui).selectedFile?.path).toBe("xy.txt");
  await escape(ui);
  expect(footer(ui)).toContain("return");
  ui.key("o", { ctrl: true });
  await ui.until("M xy.txt");
  expect(header(ui)).toStartWith(`revset: ${revsetBefore}  ·  `);
  expect(files(ui).selectedFile?.path).toBe("a b.txt");
  expect(files(ui).markedPaths).toEqual(["x*.txt"]);
}, history), 20_000);
