import { expect, test } from "bun:test";
import { join } from "node:path";
import { Repository, type Mutation } from "../src/repository";
import { fixture } from "./fixture";

async function setup() {
  const f = await fixture();
  const repo = await Repository.open(f.path);
  async function revision(revset: string) {
    const item = (await repo.snapshot(revset)).revisions[0];
    if (!item) throw new Error(`Missing revision: ${revset}`);
    return item;
  }
  async function apply(action: Mutation) { await repo.apply(await repo.prepare(action)); }
  return { ...f, repo, revision, apply };
}

test("bookmark create, move, rename and exact deletion preserve other bookmarks", async () => {
  const t = await setup();
  try {
    const current = await t.revision("@");
    const parent = await t.revision("@-");
    await t.apply({ kind: "bookmark-create", name: "work", revision: current });
    expect((await t.repo.bookmarks()).find(b => b.name === "work")?.targets).toEqual([current.commitId]);
    await t.apply({ kind: "bookmark-move", name: "work", revision: parent });
    expect((await t.repo.bookmarks()).find(b => b.name === "work")?.targets).toEqual([parent.commitId]);
    await t.apply({ kind: "bookmark-rename", name: "work", newName: "renamed" });
    expect((await t.repo.bookmarks()).some(b => b.name === "renamed")).toBe(true);
    await t.apply({ kind: "bookmark-delete", name: "renamed" });
    expect((await t.repo.bookmarks()).some(b => b.name === "renamed")).toBe(false);
    expect((await t.repo.bookmarks()).some(b => b.name === "feature")).toBe(true);
  } finally { await t.cleanup(); }
});

test("operation inspection does not write, undo reverses a bookmark and restore recovers it", async () => {
  const t = await setup();
  try {
    await t.apply({ kind: "bookmark-create", name: "recover", revision: await t.revision("@") });
    const before = await t.repo.operationId();
    const operation = (await t.repo.operations(1))[0];
    if (!operation) throw new Error("Missing operation");
    expect(operation.id).toBe(before);
    expect(operation.current).toBe(true);
    expect(await t.repo.operationDiff(operation)).toContain("recover");
    expect(await t.repo.operationId()).toBe(before);
    expect((await t.repo.operations(2))).toHaveLength(2);
    expect((await t.repo.operations(50)).length).toBeGreaterThan(2);
    await t.apply({ kind: "undo", operation });
    expect((await t.repo.bookmarks()).some(b => b.name === "recover")).toBe(false);
    await t.apply({ kind: "restore", operation });
    expect((await t.repo.bookmarks()).some(b => b.name === "recover")).toBe(true);
  } finally { await t.cleanup(); }
});

test("edit and abandon update working-copy selection and history", async () => {
  const t = await setup();
  try {
    const parent = await t.revision("@-");
    await t.apply({ kind: "edit", revision: parent });
    expect((await t.revision("@")).commitId).toBe(parent.commitId);
    await t.apply({ kind: "abandon", revision: parent });
    expect((await t.repo.snapshot("all()")).revisions.some(r => r.changeId === parent.changeId)).toBe(false);
    expect((await t.revision("@")).workingCopy).toBe(true);
  } finally { await t.cleanup(); }
});

test("rebase moves only the selected change or includes descendants", async () => {
  for (const descendants of [false, true]) {
    const t = await setup();
    try {
      const source = await t.revision("@");
      await t.jj("new", "-m", "Child");
      const child = await t.revision("@");
      await t.jj("new", "root()", "-m", "Destination");
      const destination = await t.revision("@");
      await t.apply({ kind: "rebase", revision: source, destination, descendants });
      const moved = await t.revision(source.changeId);
      expect(moved.parents).toEqual([destination.commitId]);
      const updatedChild = await t.revision(child.changeId);
      expect(updatedChild.parents).toEqual(descendants ? [moved.commitId] : source.parents);
    } finally { await t.cleanup(); }
  }
});

test("file-level split and squash preserve contents including literal filenames", async () => {
  const t = await setup();
  try {
    const odd = 'space [one] *.txt';
    await Bun.write(join(t.path, odd), "first file\n");
    await Bun.write(join(t.path, "second.txt"), "second file\n");
    const original = await t.revision("@");
    expect((await t.repo.files(original)).map(f => f.path).sort()).toEqual(["second.txt", odd].sort());
    await t.apply({ kind: "split", revision: original, files: [odd], description: "First part" });
    const first = await t.revision(original.changeId);
    const second = await t.revision(`${first.commitId}+`);
    expect(first.description.trim()).toBe("First part");
    expect(second.description.trim()).toBe("Next change");
    expect((await t.repo.files(first)).map(f => f.path)).toEqual([odd]);
    expect((await t.repo.files(second)).map(f => f.path)).toEqual(["second.txt"]);
    expect(await t.jj("diff", "--from", original.commitId, "--to", second.commitId, "--git")).toBe("");
    await t.apply({ kind: "squash", revision: second, destination: first, files: [], description: "Combined" });
    const combined = await t.revision(first.changeId);
    expect(combined.description.trim()).toBe("Combined");
    expect(await t.jj("diff", "--from", original.commitId, "--to", combined.commitId, "--git")).toBe("");
    expect((await t.repo.snapshot("all()")).revisions.some(r => r.changeId === second.changeId)).toBe(false);
  } finally { await t.cleanup(); }
});

test("stale confirmation rejects external operations and working-copy edits", async () => {
  const t = await setup();
  try {
    const action: Mutation = { kind: "bookmark-create", name: "stale", revision: await t.revision("@") };
    const external = await t.repo.prepare(action);
    await t.jj("bookmark", "create", "elsewhere");
    await expect(t.repo.apply(external)).rejects.toThrow("Repository changed");
    const worktree = await t.repo.prepare(action);
    await Bun.write(join(t.path, "external.txt"), "external content");
    await expect(t.repo.apply(worktree)).rejects.toThrow("Repository changed");
    expect((await t.repo.bookmarks()).some(b => b.name === "stale")).toBe(false);
  } finally { await t.cleanup(); }
});

test("partial squash leaves unselected files and rebase reports conflicts", async () => {
  const t = await setup();
  try {
    await Bun.write(join(t.path, "move.txt"), "move me\n");
    await Bun.write(join(t.path, "keep.txt"), "keep me\n");
    const source = await t.revision("@");
    const parent = await t.revision("@-");
    await t.apply({ kind: "squash", revision: source, destination: parent, files: ["move.txt"], description: parent.description });
    const remaining = await t.revision(source.changeId);
    expect((await t.repo.files(remaining)).map(f => f.path)).toEqual(["keep.txt"]);
    expect(await t.repo.diff(await t.revision(parent.changeId))).toContain("+move me");
    await t.jj("new", "root()", "-m", "Competing change");
    await Bun.write(join(t.path, "keep.txt"), "different content\n");
    const destination = await t.revision("@");
    const beforePreview = await t.repo.operationId();
    const prepared = await t.repo.prepare({ kind: "rebase", revision: remaining, destination, descendants: false });
    expect(prepared.trees?.after).toContain("[conflict]");
    expect(await t.repo.operationId()).toBe(beforePreview);
    await t.repo.apply(prepared);
    const conflicted = await t.revision(remaining.changeId);
    expect(conflicted.conflict).toBe(true);
    expect((await t.repo.files(conflicted)).some(f => f.path === "keep.txt")).toBe(true);
  } finally { await t.cleanup(); }
});

test("immutable edits fail without recording a successful operation", async () => {
  const t = await setup();
  try {
    const root = await t.revision("root()");
    const prepared = await t.repo.prepare({ kind: "edit", revision: root });
    const before = await t.repo.operationId();
    await expect(t.repo.apply(prepared)).rejects.toThrow();
    expect(await t.repo.operationId()).toBe(before);
  } finally { await t.cleanup(); }
});
