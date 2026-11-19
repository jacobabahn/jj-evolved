import { expect, test } from "bun:test";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TextRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";
import { Repository } from "../src/repository/repository";
import { mutationArgs } from "../src/repository/mutation";
import type { Mutation } from "../src/repository/model";
import type { FileList } from "../src/revisions/file-list";
import { fixture } from "./fixture";

type Ui = Parameters<Parameters<typeof withUiFixture>[1]>[0];
type Jj = { path: string; jj(...args: string[]): Promise<string> };
const footer = (ui: Ui) => (ui.node("shortcuts") as TextRenderable).plainText;
const files = (ui: Ui) => ui.node("changed-files") as unknown as FileList;
const exact = (description: string) => `description(exact:${JSON.stringify(`${description}\n`)})`;

/**
 * "Base" adds four files, with a space and wildcard characters in their names. "Edits", the change the browser opens,
 * edits three of them, deletes gone.txt and renames hello.txt. "Child" builds on Edits and is the working copy, so a
 * restore into Edits rebases it. "Other", a sibling of Edits, has its own content for a b.txt and x*.txt.
 */
const base: Record<string, string> = { "a b.txt": "a b base\n", "x*.txt": "x* base\n", "xy.txt": "xy base\n", "gone.txt": "gone base\n" };
const edited: Record<string, string> = { "a b.txt": "a b edited\n", "x*.txt": "x* edited\n", "xy.txt": "xy edited\n", "moved [v1].txt": "hello from jj-evolved\n" };
async function prepare(f: Jj) {
  await f.jj("describe", "-m", "Base");
  for (const [name, text] of Object.entries(base)) await Bun.write(join(f.path, name), text);
  await f.jj("new", "-m", "Edits");
  for (const name of ["a b.txt", "x*.txt", "xy.txt"]) await Bun.write(join(f.path, name), edited[name]!);
  await rm(join(f.path, "gone.txt"));
  await rename(join(f.path, "hello.txt"), join(f.path, "moved [v1].txt"));
  await f.jj("new", "-m", "Child");
  await Bun.write(join(f.path, "child.txt"), "child\n");
  await f.jj("new", exact("Base"), "-m", "Other");
  await Bun.write(join(f.path, "a b.txt"), "a b other\n");
  await Bun.write(join(f.path, "x*.txt"), "x* other\n");
  await f.jj("edit", exact("Child"));
}
const allEdits = ["D gone.txt", "M a b.txt", "M x*.txt", "M xy.txt", "R {hello.txt => moved [v1].txt}"];
async function summary(f: Jj, revset: string) {
  return (await f.jj("diff", "-r", revset, "--summary")).trim().split("\n").filter(Boolean).sort();
}
async function content(f: Jj, revset: string, path: string) {
  return f.jj("file", "show", "-r", revset, `root-file:${JSON.stringify(path)}`).catch(() => null);
}

test("restoring a file from the parent previews the source, destination, paths, diff and rebased descendants, then undoes only that file's edits", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const repo = await Repository.open(f.path);
    const [edits] = (await repo.snapshot(exact("Edits"))).revisions;
    const [parent] = (await repo.snapshot(exact("Base"))).revisions;
    // As a glob, x*.txt would also match xy.txt.
    const action: Mutation = { kind: "restore-files", revision: edits!, files: ["x*.txt"] };
    expect(mutationArgs(action)).toEqual(["restore", "--changes-in", edits!.commitId, "--", 'root-file:"x*.txt"']);
    expect(() => mutationArgs({ ...action, files: [] })).toThrow("Choose at least one file to restore.");
    const operation = await repo.operationId();
    const prepared = await repo.prepare(action);
    const text = prepared.summary;
    expect(text).toContain(`From its parent ${parent!.changeId.slice(0, 8)}`);
    expect(text).toContain(`Into ${edits!.changeId.slice(0, 8)}`);
    expect(text).toContain(`Overwrites this path in ${edits!.changeId.slice(0, 8)} with the source's content:\n  x*.txt\n`);
    expect(text).toMatch(/Descendants of \w+ are rebased onto the result \(1\):\n↳ \w+ \/ \w+ Child/);
    expect(text).toContain("-x* edited\n+x* base");
    expect(text).not.toContain("xy.txt");
    expect(text).not.toContain("a b.txt");
    // Previewing changed nothing, the working copy included.
    expect(await repo.operationId()).toBe(operation);
    expect(await Bun.file(join(f.path, "x*.txt")).text()).toBe(edited["x*.txt"]!);

    await repo.apply(prepared);
    expect(await summary(f, exact("Edits"))).toEqual(allEdits.filter(line => line !== "M x*.txt"));
    expect(await summary(f, exact("Child"))).toEqual(["A child.txt"]);
    expect(await Bun.file(join(f.path, "x*.txt")).text()).toBe(base["x*.txt"]!);
    expect(await Bun.file(join(f.path, "xy.txt")).text()).toBe(edited["xy.txt"]!);
  } finally { await f.cleanup(); }
}, 20_000);

test("restoring from another revision names it as the source and brings its content for the chosen paths, a rename included", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const repo = await Repository.open(f.path);
    const [edits] = (await repo.snapshot(exact("Edits"))).revisions;
    const [other] = (await repo.snapshot(exact("Other"))).revisions;
    const action: Mutation = { kind: "restore-files", revision: edits!, files: ["a b.txt", "moved [v1].txt"], from: other! };
    expect(mutationArgs(action)).toEqual(["restore", "--from", other!.commitId, "--into", edits!.commitId, "--", 'root-file:"a b.txt"', 'root-file:"moved [v1].txt"']);
    const prepared = await repo.prepare(action);
    // The renamed file's old path is restored with it.
    expect(prepared.action).toEqual({ ...action, renameSources: ["hello.txt"] });
    expect(mutationArgs(prepared.action)).toEqual(["restore", "--from", other!.commitId, "--into", edits!.commitId, "--",
      'root-file:"a b.txt"', 'root-file:"moved [v1].txt"', 'root-file:"hello.txt"']);
    expect(prepared.summary).toContain(`From ${other!.changeId.slice(0, 8)}`);
    expect(prepared.summary).toContain(`Overwrites these 3 paths in ${edits!.changeId.slice(0, 8)} with the source's content:\n  a b.txt\n  moved [v1].txt\n  hello.txt\n`);
    expect(prepared.summary).toContain("-a b edited\n+a b other");
    expect(prepared.summary).not.toContain("x*.txt");
    await repo.apply(prepared);
    expect(await summary(f, exact("Edits"))).toEqual(["D gone.txt", "M a b.txt", "M x*.txt", "M xy.txt"]);
    expect(await content(f, exact("Edits"), "a b.txt")).toBe("a b other\n");
    expect(await content(f, exact("Edits"), "x*.txt")).toBe(edited["x*.txt"]!);
    expect(await content(f, exact("Edits"), "hello.txt")).toBe("hello from jj-evolved\n");
    expect(await content(f, exact("Edits"), "moved [v1].txt")).toBeNull();
  } finally { await f.cleanup(); }
}, 20_000);

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
// The browser opens on Edits, the working copy's parent.
async function openEdits(ui: Ui) {
  await ui.until("Ready.");
  ui.key("[");
  await ui.until("Edits");
  await ui.settled();
  ui.key("l");
  await ui.until("moved [v1].txt");
}

test("restore from the parent on the highlighted file undoes only its edits; on a selection it restores a deleted file and a rename", () => withUiFixture("file-restore-parent", async ui => {
  await openEdits(ui);
  const id = (await ui.repo.snapshot(exact("Edits"))).revisions[0]!.changeId.slice(0, 8);
  await highlight(ui, "x*.txt");
  expect(footer(ui)).toContain("m actions · highlighted file");
  ui.key("r");
  await ui.until("Restore files preview · 1 file from parent");
  expect(ui.screen.captureCharFrame()).toContain("From its parent");
  ui.key("RETURN");
  await ui.until(`Restored 1 file of ${id} from its parent.`);
  expect(await summary(ui.f, exact("Edits"))).toEqual(allEdits.filter(line => line !== "M x*.txt"));
  expect(await content(ui.f, exact("Edits"), "x*.txt")).toBe(base["x*.txt"]!);

  // The deleted file comes back, the rename is undone whole, and the unselected file keeps its edit.
  await ui.settled();
  ui.key("l");
  await ui.until("m actions · highlighted file");
  await mark(ui, "gone.txt", "moved [v1].txt", "a b.txt");
  expect(footer(ui)).toContain("m actions · 3 selected");
  ui.key("r");
  await ui.until("Restore files preview · 3 files from parent");
  ui.key("RETURN");
  await ui.until(`Restored 3 files of ${id} from its parent.`);
  expect(await summary(ui.f, exact("Edits"))).toEqual(["M xy.txt"]);
  expect(await content(ui.f, exact("Edits"), "gone.txt")).toBe(base["gone.txt"]!);
  expect(await content(ui.f, exact("Edits"), "hello.txt")).toBe("hello from jj-evolved\n");
  expect(await content(ui.f, exact("Edits"), "moved [v1].txt")).toBeNull();
  // Child was rebased onto the result, and the working copy followed it.
  expect(await summary(ui.f, "@")).toEqual(["A child.txt"]);
  expect(await Bun.file(join(ui.f.path, "gone.txt")).text()).toBe(base["gone.txt"]!);
  expect(await Bun.file(join(ui.f.path, "xy.txt")).text()).toBe(edited["xy.txt"]!);
}, { prepare }), 20_000);

test("restore from another revision through the menu brings the chosen revision's content for the selected files only", () => withUiFixture("file-restore-other", async ui => {
  await openEdits(ui);
  const [edits] = (await ui.repo.snapshot(exact("Edits"))).revisions;
  const [other] = (await ui.repo.snapshot(exact("Other"))).revisions;
  await mark(ui, "a b.txt", "x*.txt");
  ui.key("m");
  await ui.until("File actions · 2 selected");
  ui.choose("Restore from another revision · 2 selected");
  await ui.until(`Restore 2 selected of ${edits!.changeId.slice(0, 8)} from`);
  ui.choose(`${other!.changeId.slice(0, 8)} Other`);
  await ui.until(`Restore files preview · 2 files from ${other!.changeId.slice(0, 8)}`);
  ui.key("RETURN");
  await ui.until(`Restored 2 files of ${edits!.changeId.slice(0, 8)} from ${other!.changeId.slice(0, 8)}.`);
  expect(await content(ui.f, exact("Edits"), "a b.txt")).toBe("a b other\n");
  expect(await content(ui.f, exact("Edits"), "x*.txt")).toBe("x* other\n");
  expect(await content(ui.f, exact("Edits"), "xy.txt")).toBe(edited["xy.txt"]!);
  expect(await summary(ui.f, exact("Edits"))).toEqual(allEdits);
}, { prepare }), 20_000);

test("cancelling a restore at any step returns to the browser with its selection and changes nothing", () => withUiFixture("file-restore-cancel", async ui => {
  await openEdits(ui);
  const [other] = (await ui.repo.snapshot(exact("Other"))).revisions;
  await mark(ui, "a b.txt", "x*.txt");
  await highlight(ui, "xy.txt");
  const operation = await ui.repo.operationId();
  async function backInBrowser(step: string) {
    await ui.until("m actions · 2 selected");
    expect({ step, marked: files(ui).markedPaths, highlighted: files(ui).selectedFile?.path })
      .toEqual({ step, marked: ["a b.txt", "x*.txt"], highlighted: "xy.txt" });
    expect(ui.node("changed-files").visible).toBe(true);
    expect(await ui.repo.operationId()).toBe(operation);
  }

  ui.key("r");
  await ui.until("Restore files preview · 2 files from parent");
  await escape(ui);
  await backInBrowser("review from the key");

  ui.key("m");
  await ui.until("File actions · 2 selected");
  ui.choose("Restore from parent · 2 selected");
  await ui.until("Restore files preview · 2 files from parent");
  await escape(ui);
  await ui.until("File actions · 2 selected");
  await escape(ui);
  await backInBrowser("review from the menu");

  ui.key("m");
  await ui.until("File actions · 2 selected");
  ui.choose("Restore from another revision · 2 selected");
  await ui.until("Restore 2 selected of");
  await escape(ui);
  await ui.until("File actions · 2 selected");
  await escape(ui);
  await backInBrowser("source picker");

  ui.key("m");
  await ui.until("File actions · 2 selected");
  ui.choose("Restore from another revision · 2 selected");
  await ui.until("Restore 2 selected of");
  ui.choose(`${other!.changeId.slice(0, 8)} Other`);
  await ui.until("Restore files preview · 2 files from");
  for (const next of ["Restore 2 selected of", "File actions · 2 selected"]) { await escape(ui); await ui.until(next); }
  await escape(ui);
  await backInBrowser("review of another revision");

  expect(await summary(ui.f, exact("Edits"))).toEqual(allEdits);
  for (const name of ["a b.txt", "x*.txt", "xy.txt"]) expect(await Bun.file(join(ui.f.path, name)).text()).toBe(edited[name]!);
}, { prepare }), 30_000);
