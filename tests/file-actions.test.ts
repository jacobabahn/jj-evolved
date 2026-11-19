import { expect, test } from "bun:test";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelectRenderable, TextRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";
import type { FileList } from "../src/revisions/file-list";

type Ui = Parameters<Parameters<typeof withUiFixture>[1]>[0];
const footer = (ui: Ui) => (ui.node("shortcuts") as TextRenderable).plainText;
const files = (ui: Ui) => ui.node("changed-files") as unknown as FileList;
const options = (ui: Ui, id = "action-choices") => (ui.node(id) as SelectRenderable).options.map(option => option.value ?? option.name);
const summary = async (ui: Ui, revision: string) => (await ui.f.jj("diff", "-r", revision, "--summary")).trim().split("\n").sort();

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
async function mark(ui: Ui, ...paths: string[]) {
  for (const path of paths) { await highlight(ui, path); ui.key(" "); await ui.settled(); }
}
// A lone Escape reaches the app after the terminal parser's escape delay.
async function escape(ui: Ui) { ui.key("ESCAPE"); await Bun.sleep(60); await ui.settled(); }
async function openFiles(ui: Ui) {
  await ui.until("Ready.");
  ui.key("l");
  await ui.until("star*.txt");
}

// The working copy, "Tricky paths", adds paths with a space and wildcard characters, deletes one file and renames another.
const contents: Record<string, string> = { "a b.txt": "a b\n", "star*.txt": "star\n", "q?.txt": "question\n", "[x].txt": "bracket\n", "moved [v1].txt": "hello from jj-evolved\n" };
const tricky = {
  prepare: async (f: { path: string; jj(...args: string[]): Promise<string> }) => {
    await Bun.write(join(f.path, "gone.txt"), "soon removed\n");
    await f.jj("new", "-m", "Tricky paths");
    await rm(join(f.path, "gone.txt"));
    await rename(join(f.path, "hello.txt"), join(f.path, "moved [v1].txt"));
    for (const [name, text] of Object.entries(contents)) if (name !== "moved [v1].txt") await Bun.write(join(f.path, name), text);
  },
};
const everything = ["A [x].txt", "A a b.txt", "A q?.txt", "A star*.txt", "D gone.txt", "R {hello.txt => moved [v1].txt}"];
async function unchangedFiles(ui: Ui) {
  for (const [name, text] of Object.entries(contents)) expect(await Bun.file(join(ui.f.path, name)).text()).toBe(text);
}

test("split from the selection ticks the selected files, and the first change holds exactly them, a rename included", () => withUiFixture("file-split-selection", async ui => {
  await openFiles(ui);
  const source = (await ui.repo.snapshot("@")).revisions[0]!;
  expect(footer(ui)).toContain("m actions · highlighted file");
  await mark(ui, "star*.txt", "a b.txt", "moved [v1].txt");
  expect(footer(ui)).toContain("m actions · 3 selected");

  ui.key("s");
  await ui.until("Split files · 3 selected");
  expect(options(ui)).toEqual(["[ ] A [x].txt", "[x] A a b.txt", "[ ] D gone.txt", "[x] R moved [v1].txt", "[ ] A q?.txt", "[x] A star*.txt", "Continue with 3 files"]);
  ui.key("c");
  await ui.until("First change description");
  await ui.type("Split out");
  ui.key("RETURN");
  await ui.until("Keep original description");
  ui.choose("Keep original description");
  await ui.until("Review before applying");
  ui.key("RETURN");
  await ui.until(`Split ${source.changeId.slice(0, 8)}.`);

  // The selected files, the whole rename among them, go into the first change; the rest stay in the second.
  const first = "description(exact:'Split out\n')", second = "description(exact:'Tricky paths\n')";
  expect(await summary(ui, first)).toEqual(["A a b.txt", "A star*.txt", "R {hello.txt => moved [v1].txt}"]);
  expect(await summary(ui, second)).toEqual(["A [x].txt", "A q?.txt", "D gone.txt"]);
  expect((await ui.f.jj("log", "--no-graph", "-r", `parents(${second})`, "-T", "description")).trim()).toBe("Split out");
  expect(await ui.f.jj("file", "show", "-r", first, 'root-file:"a b.txt"')).toBe(contents["a b.txt"]!);
  await unchangedFiles(ui);
}, tricky), 20_000);

test("squash from the highlighted file opens the form with it as the files, and moves only it", () => withUiFixture("file-squash-highlighted", async ui => {
  await openFiles(ui);
  await highlight(ui, "star*.txt");
  expect(footer(ui)).toContain("m actions · highlighted file");
  ui.key("S");
  await ui.until("Squash changes");
  await ui.until("Files: 1 selected");
  ui.choose("Files: 1 selected", "history-fields");
  await ui.until("[x] star*.txt");
  expect(options(ui, "history-choices").filter(name => name.startsWith("[x]"))).toEqual(["[x] star*.txt"]);
  await escape(ui);
  ui.choose("Destination: Choose a revision", "history-fields");
  await ui.until("/ search all destinations");
  ui.key("/"); await ui.type("Next change"); ui.key("RETURN");
  await ui.until("Preview ready");
  ui.choose("Apply squash", "history-fields");
  await ui.until("Squashed");

  expect(await summary(ui, "description(exact:'Next change\n')")).toEqual(["A gone.txt", "A star*.txt"]);
  expect(await summary(ui, "description(exact:'Tricky paths\n')")).toEqual(everything.filter(line => line !== "A star*.txt"));
  await unchangedFiles(ui);
}, tricky), 20_000);

test("squash from the selection moves the selected files, a rename included, and leaves the rest", () => withUiFixture("file-squash-selection", async ui => {
  await openFiles(ui);
  await mark(ui, "moved [v1].txt", "a b.txt");
  ui.key("m");
  await ui.until("File actions · 2 selected");
  expect(options(ui)).toEqual(["Split · 2 selected", "Split in diff editor · 2 selected", "Squash · 2 selected", "Squash in diff editor · 2 selected"]);
  ui.choose("Squash · 2 selected");
  await ui.until("Files: 2 selected");
  ui.choose("Destination: Choose a revision", "history-fields");
  await ui.until("/ search all destinations");
  ui.key("/"); await ui.type("Next change"); ui.key("RETURN");
  await ui.until("Preview ready");
  ui.choose("Apply squash", "history-fields");
  await ui.until("Squashed");

  expect(await summary(ui, "description(exact:'Next change\n')")).toEqual(["A a b.txt", "A gone.txt", "R {hello.txt => moved [v1].txt}"]);
  expect(await summary(ui, "description(exact:'Tricky paths\n')")).toEqual(["A [x].txt", "A q?.txt", "A star*.txt", "D gone.txt"]);
  await unchangedFiles(ui);
}, tricky), 20_000);

test("cancelling split or squash at any step returns to the browser with its selection and filter, and changes nothing", () => withUiFixture("file-actions-cancel", async ui => {
  await openFiles(ui);
  await mark(ui, "a b.txt", "star*.txt");
  // Filter so the highlighted file is one that is not selected; the targets are still the two selected files.
  ui.key("/");
  await ui.until("Enter keep filter");
  await ui.type("?");
  ui.key("RETURN");
  await ui.until("/?  1 of 6 files");
  const operation = await ui.repo.operationId();
  async function backInBrowser(step: string) {
    await ui.until("/?  1 of 6 files");
    expect({ step, marked: files(ui).markedPaths, filter: files(ui).filter, highlighted: files(ui).selectedFile?.path })
      .toEqual({ step, marked: ["a b.txt", "star*.txt"], filter: "?", highlighted: "q?.txt" });
    expect(footer(ui)).toContain("m actions · 2 selected");
    expect(ui.node("changed-files").visible).toBe(true);
  }

  ui.key("s");
  await ui.until("Split files · 2 selected");
  await escape(ui);
  await backInBrowser("split chooser");

  // Back through each level of the split: the second description, the first, the chooser, then the browser.
  ui.key("s");
  await ui.until("Split files · 2 selected");
  ui.key("c");
  await ui.until("First change description");
  ui.key("RETURN");
  await ui.until("Keep original description");
  ui.choose("Keep original description");
  await ui.until("Review before applying");
  for (const next of ["Keep original description", "First change description", "Split files · 2 selected"]) { await escape(ui); await ui.until(next); }
  await escape(ui);
  await backInBrowser("split review");

  ui.key("S");
  await ui.until("Files: 2 selected");
  await escape(ui);
  await backInBrowser("squash form");

  ui.key("m");
  await ui.until("File actions · 2 selected");
  await escape(ui);
  await backInBrowser("actions menu");

  ui.key("m");
  await ui.until("File actions · 2 selected");
  ui.choose("Squash in diff editor · 2 selected");
  await ui.until("Squash 2 selected in diff editor into");
  await escape(ui);
  await ui.until("File actions · 2 selected");
  await escape(ui);
  await backInBrowser("diff editor destination");

  expect(await ui.repo.operationId()).toBe(operation);
  expect(await summary(ui, "@")).toEqual(everything);
  await unchangedFiles(ui);
}, tricky), 30_000);

// A diff editor that records the files jj offers it and keeps all of them, or fails when told to.
async function recordingEditor(f: { path: string; jj(...args: string[]): Promise<string> }) {
  const directory = await mkdtemp(join(tmpdir(), "jj-evolved-file-editor-"));
  const editor = join(directory, "editor.js"), offered = join(directory, "offered"), mode = join(directory, "mode");
  await Bun.write(mode, "keep");
  await Bun.write(editor, `
    const fs = require("node:fs");
    const path = require("node:path");
    const [modeFile, offeredFile, left, right] = process.argv.slice(2);
    if (!right) process.exit(0);
    const list = dir => fs.readdirSync(dir, { recursive: true }).filter(name => fs.statSync(path.join(dir, name)).isFile() && !name.startsWith("JJ-INSTRUCTIONS"));
    fs.writeFileSync(offeredFile, JSON.stringify([...new Set([...list(left), ...list(right)])].sort()));
    if (fs.readFileSync(modeFile, "utf8") === "fail") process.exit(1);
  `);
  await f.jj("config", "set", "--repo", "ui.diff-editor", "file-test");
  await f.jj("config", "set", "--repo", "merge-tools.file-test.program", process.execPath);
  await f.jj("config", "set", "--repo", "merge-tools.file-test.edit-args", JSON.stringify([editor, mode, offered, "$left", "$right"]));
  await f.jj("config", "set", "--repo", "ui.editor", JSON.stringify([process.execPath, editor, mode, offered]));
  return { offered, mode, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

for (const kind of ["split", "squash"] as const) {
  test(`${kind} in the diff editor from the selection offers only the selected files, as literal paths`, async () => {
    let editor: Awaited<ReturnType<typeof recordingEditor>> | undefined;
    try {
      await withUiFixture(`file-${kind}-editor`, async ui => {
        await openFiles(ui);
        const source = (await ui.repo.snapshot("@")).revisions[0]!;
        await mark(ui, "star*.txt", "a b.txt", "moved [v1].txt");
        ui.key("m");
        await ui.until("File actions · 3 selected");
        ui.choose(`${kind === "split" ? "Split" : "Squash"} in diff editor · 3 selected`);
        if (kind === "squash") {
          await ui.until("Squash 3 selected in diff editor into");
          ui.key("/"); await ui.type("Next change"); ui.key("RETURN");
        }
        for (let attempt = 0; attempt < 300 && !await Bun.file(editor!.offered).exists(); attempt++) { await ui.screen.renderOnce(); await Bun.sleep(10); }
        await ui.until("Ready.");
        await ui.settled();
        // The rename's old path comes along, so the rename moves whole.
        expect(JSON.parse(await Bun.file(editor!.offered).text())).toEqual(["a b.txt", "hello.txt", "moved [v1].txt", "star*.txt"]);
        const moved = ["A a b.txt", "A star*.txt", "R {hello.txt => moved [v1].txt}"];
        const rest = ["A [x].txt", "A q?.txt", "D gone.txt"];
        if (kind === "split") {
          expect(await summary(ui, source.changeId)).toEqual(moved);
          expect(await summary(ui, `children(${source.changeId})`)).toEqual(rest);
        } else {
          expect(await summary(ui, "description(exact:'Next change\n')")).toEqual([...moved, "A gone.txt"].sort());
          expect(await summary(ui, source.changeId)).toEqual(rest);
        }
        await unchangedFiles(ui);
      }, { prepare: async f => { await tricky.prepare(f); editor = await recordingEditor(f); } });
    } finally { await editor?.cleanup(); }
  }, 20_000);
}

test("a diff editor that fails returns to the browser with its selection and filter, and changes nothing", async () => {
  let editor: Awaited<ReturnType<typeof recordingEditor>> | undefined;
  try {
    await withUiFixture("file-split-editor-fails", async ui => {
      await Bun.write(editor!.mode, "fail");
      await openFiles(ui);
      await mark(ui, "a b.txt", "q?.txt");
      ui.key("/");
      await ui.until("Enter keep filter");
      await ui.type("a");
      ui.key("RETURN");
      await ui.until("/a  2 of 6 files");
      await highlight(ui, "star*.txt");
      const operation = await ui.repo.operationId();
      ui.key("m");
      await ui.until("File actions · 2 selected");
      ui.choose("Split in diff editor · 2 selected");
      await ui.until("did not complete");
      await ui.until("/a  2 of 6 files");
      expect(JSON.parse(await Bun.file(editor!.offered).text())).toEqual(["a b.txt", "q?.txt"]);
      expect({ marked: files(ui).markedPaths, filter: files(ui).filter, highlighted: files(ui).selectedFile?.path })
        .toEqual({ marked: ["a b.txt", "q?.txt"], filter: "a", highlighted: "star*.txt" });
      expect(await ui.repo.operationId()).toBe(operation);
      expect(await summary(ui, "@")).toEqual(everything);
      await unchangedFiles(ui);
    }, { prepare: async f => { await tricky.prepare(f); editor = await recordingEditor(f); } });
  } finally { await editor?.cleanup(); }
}, 20_000);
