import { expect, test } from "bun:test";
import { rename } from "node:fs/promises";
import { Repository } from "../src/repository/repository";
import type { Mutation } from "../src/repository/model";
import { mutationArgs } from "../src/repository/mutation";
import { fixture } from "./fixture";

async function revision(repo: Repository, revset: string) {
  const item = (await repo.snapshot(revset)).revisions[0];
  if (!item) throw new Error(`Missing revision: ${revset}`);
  return item;
}

test("absorb previews two recipients and leftovers without applying, then rewrites the selected source", async () => {
  const f = await fixture();
  try {
    await Bun.write(`${f.path}/second.txt`, "second original\n");
    await f.jj("describe", "-m", "Second recipient");
    await f.jj("bookmark", "create", "second");
    await f.jj("new", "-m", "Review fixes");
    await Bun.write(`${f.path}/hello.txt`, "first corrected\n");
    await Bun.write(`${f.path}/second.txt`, "second corrected\n");
    await Bun.write(`${f.path}/unassigned.txt`, "leave this here\n");
    const repo = await Repository.open(f.path);
    const source = await revision(repo, "@");
    await f.jj("new", "-m", "Descendant working copy");
    const workingCopy = await revision(repo, "@");
    const before = await repo.snapshot("all()");
    const operation = await repo.operationId();
    const prepared = await repo.prepare({ kind: "absorb", revision: source });
    expect(prepared.summary).toContain("Absorbed changes into 2 revisions");
    expect(prepared.summary).toContain("Initial feature");
    expect(prepared.summary).toContain("Second recipient");
    expect(prepared.summary).toContain("+first corrected");
    expect(prepared.summary).toContain("+second corrected");
    const remaining = prepared.summary.split("Remaining in source:")[1];
    expect(remaining).toContain("+leave this here");
    expect(remaining).not.toContain("first corrected");
    expect(remaining).not.toContain("second corrected");
    expect(await repo.operationId()).toBe(operation);
    expect(await repo.snapshot("all()")).toEqual(before);
    expect(await Bun.file(`${f.path}/hello.txt`).text()).toBe("first corrected\n");
    await repo.apply(prepared);
    expect(await f.jj("file", "show", "-r", "feature", "hello.txt")).toBe("first corrected\n");
    expect(await f.jj("file", "show", "-r", "second", "second.txt")).toBe("second corrected\n");
    const retained = await revision(repo, source.changeId);
    expect(await repo.diff(retained)).toContain("+leave this here");
    expect(await repo.files(retained)).toEqual([{ path: "unassigned.txt", status: "added" }]);
    expect((await revision(repo, "@")).changeId).toBe(workingCopy.changeId);
  } finally { await f.cleanup(); }
}, 15_000);

// An ancestor owns three files whose names jj would read as fileset syntax or glob patterns; the source edits all three.
async function absorbableFiles(f: Awaited<ReturnType<typeof fixture>>) {
  const names = ["a b.txt", "x*.txt", "xy.txt"];
  for (const name of names) await Bun.write(`${f.path}/${name}`, `${name} original\n`);
  await f.jj("describe", "-m", "Owners");
  await f.jj("new", "-m", "Fixes");
  for (const name of names) await Bun.write(`${f.path}/${name}`, `${name} fixed\n`);
  return names;
}

test("absorb limited to files moves only their edits, takes each path literally, and its preview lists only them", async () => {
  const f = await fixture();
  try {
    await absorbableFiles(f);
    const repo = await Repository.open(f.path);
    const source = await revision(repo, "@");
    // As a glob, x*.txt would also match xy.txt.
    const action: Mutation = { kind: "absorb", revision: source, files: ["x*.txt"] };
    expect(mutationArgs(action)).toEqual(["absorb", "--from", source.commitId, "--", 'root-file:"x*.txt"']);
    const operation = await repo.operationId();
    const prepared = await repo.prepare(action);
    expect(prepared.summary).toContain("Only this file's edits can move; other files' edits stay in the source:\n  x*.txt\n");
    const [, projected = "", remaining = ""] = prepared.summary.split(/Projected changes:|Remaining in source:/);
    expect(projected).toContain("+x*.txt fixed");
    expect(projected).not.toContain("xy.txt");
    expect(projected).not.toContain("a b.txt");
    expect(remaining).toContain("+xy.txt fixed");
    expect(remaining).toContain("+a b.txt fixed");
    expect(remaining).not.toContain("x*.txt");
    expect(await repo.operationId()).toBe(operation);
    await repo.apply(prepared);
    const owners = "description(exact:'Owners\n')";
    expect(await f.jj("file", "show", "-r", owners, 'root-file:"x*.txt"')).toBe("x*.txt fixed\n");
    expect(await f.jj("file", "show", "-r", owners, 'root-file:"xy.txt"')).toBe("xy.txt original\n");
    expect(await f.jj("file", "show", "-r", owners, 'root-file:"a b.txt"')).toBe("a b.txt original\n");
    expect((await repo.files(await revision(repo, source.changeId))).map(file => file.path)).toEqual(["a b.txt", "xy.txt"]);
  } finally { await f.cleanup(); }
}, 15_000);

test("absorb limited to a path with a space moves it with the others chosen, and absorb with no files still moves every file", async () => {
  for (const files of [["a b.txt", "xy.txt"], undefined]) {
    const f = await fixture();
    try {
      await absorbableFiles(f);
      const repo = await Repository.open(f.path);
      const source = await revision(repo, "@");
      const prepared = await repo.prepare({ kind: "absorb", revision: source, ...(files ? { files } : {}) });
      expect(prepared.summary.includes("other files' edits stay in the source")).toBe(!!files);
      await repo.apply(prepared);
      const owners = "description(exact:'Owners\n')";
      for (const name of ["a b.txt", "x*.txt", "xy.txt"]) {
        const moved = !files || files.includes(name);
        expect(await f.jj("file", "show", "-r", owners, `root-file:${JSON.stringify(name)}`)).toBe(`${name} ${moved ? "fixed" : "original"}\n`);
      }
      expect((await repo.files(await revision(repo, source.changeId))).map(file => file.path)).toEqual(files ? ["x*.txt"] : []);
    } finally { await f.cleanup(); }
  }
}, 20_000);

test("absorb limited to a renamed file leaves the rename whole in the source and the old path in the ancestor", async () => {
  const f = await fixture();
  try {
    // The fixture's "Initial feature" adds hello.txt; the source renames it.
    await rename(`${f.path}/hello.txt`, `${f.path}/moved [v1].txt`);
    const repo = await Repository.open(f.path);
    const source = await revision(repo, "@");
    expect(await repo.files(source)).toEqual([{ path: "moved [v1].txt", status: "renamed", source: "hello.txt" }]);
    const prepared = await repo.prepare({ kind: "absorb", revision: source, files: ["moved [v1].txt"] });
    // Only the new path goes to jj: given the old path too, jj would move its deletion into the ancestor.
    expect(prepared.action).toMatchObject({ files: ["moved [v1].txt"] });
    await repo.apply(prepared);
    expect(await f.jj("file", "list", "-r", "feature")).toBe("hello.txt\n");
    expect(await f.jj("file", "show", "-r", "feature", "hello.txt")).toBe("hello from jj-evolved\n");
    expect(await repo.files(await revision(repo, source.changeId))).toEqual([{ path: "moved [v1].txt", status: "renamed", source: "hello.txt" }]);
  } finally { await f.cleanup(); }
});

for (const described of [false, true]) {
  test(`absorb fully assigned source, described=${described}`, async () => {
    const f = await fixture();
    try {
      await f.jj("describe", "-m", described ? "Keep this change" : "");
      await Bun.write(`${f.path}/hello.txt`, "fully absorbed\n");
      const repo = await Repository.open(f.path);
      const source = await revision(repo, "@");
      const operation = await repo.operationId();
      const prepared = await repo.prepare({ kind: "absorb", revision: source });
      expect(prepared.summary).toContain(described ? "No file differences remain" : "source becomes empty and is abandoned");
      expect(await repo.operationId()).toBe(operation);
      await repo.apply(prepared);
      expect(await f.jj("file", "show", "-r", "feature", "hello.txt")).toBe("fully absorbed\n");
      expect((await repo.snapshot(`present(${source.changeId})`)).revisions.length).toBe(described ? 1 : 0);
      expect(await repo.diff(await revision(repo, "@"))).toBe("");
      expect(await Bun.file(`${f.path}/hello.txt`).text()).toBe("fully absorbed\n");
    } finally { await f.cleanup(); }
  });
}

test("absorb no-op explicitly keeps unassignable edits and does not create an operation", async () => {
  const f = await fixture();
  try {
    await Bun.write(`${f.path}/new.txt`, "no ancestor owns this\n");
    const repo = await Repository.open(f.path);
    const source = await revision(repo, "@");
    const operation = await repo.operationId();
    const prepared = await repo.prepare({ kind: "absorb", revision: source });
    expect(prepared.summary).toContain("Nothing to absorb. No changes will move.");
    expect(prepared.summary.split("Remaining in source:")[1]).toContain("+no ancestor owns this");
    await repo.apply(prepared);
    expect(await repo.operationId()).toBe(operation);
  } finally { await f.cleanup(); }
});

for (const external of ["operation", "file"]) {
  test(`absorb rejects a stale preview after an external ${external}`, async () => {
    const f = await fixture();
    try {
      await Bun.write(`${f.path}/hello.txt`, "fix\n");
      const repo = await Repository.open(f.path);
      const prepared = await repo.prepare({ kind: "absorb", revision: await revision(repo, "@") });
      if (external === "operation") await f.jj("bookmark", "create", "external");
      else await Bun.write(`${f.path}/hello.txt`, "newer unsnapshotted fix\n");
      await expect(repo.apply(prepared)).rejects.toThrow("Repository changed since this preview");
      expect(await f.jj("file", "show", "-r", "feature", "hello.txt")).toBe("hello from jj-evolved\n");
    } finally { await f.cleanup(); }
  });
}

test("absorb respects immutable ancestors and rejects an obsolete selected source", async () => {
  const f = await fixture();
  try {
    await f.jj("config", "set", "--repo", 'revset-aliases."immutable_heads()"', "feature");
    await Bun.write(`${f.path}/hello.txt`, "immutable fix\n");
    const repo = await Repository.open(f.path);
    const source = await revision(repo, "@");
    const prepared = await repo.prepare({ kind: "absorb", revision: source });
    expect(prepared.summary).toContain("Nothing to absorb");
    await f.jj("describe", "-m", "Rewritten elsewhere");
    await expect(repo.prepare({ kind: "absorb", revision: source })).rejects.toThrow("selected revision has changed");
  } finally { await f.cleanup(); }
});

test("evolution includes content and description rewrites and leaves unsnapshotted edits alone", async () => {
  const f = await fixture();
  try {
    await f.jj("config", "set", "--repo", "ui.log-word-wrap", "true");
    const repo = await Repository.open(f.path);
    const original = await revision(repo, "@");
    await Bun.write(`${f.path}/hello.txt`, "changed content\n");
    const contentVersion = await revision(repo, "@");
    await f.jj("describe", "-m", "Renamed version\nWith details");
    const current = await revision(repo, "@");
    const operation = await repo.operationId();
    await Bun.write(`${f.path}/hello.txt`, "unsnapshotted content\n");
    const page = await repo.evolution(current);
    expect(page.entries.map(entry => entry.commitId)).toEqual([current.commitId, contentVersion.commitId, original.commitId]);
    expect(page.hasMore).toBe(false);
    const [renamed, changed, initial] = page.entries;
    if (!renamed || !changed || !initial) throw new Error("Missing evolution entries");
    const descriptionDiff = await repo.evolutionDiff(page.operationId, renamed);
    expect(descriptionDiff).toContain("JJ-COMMIT-DESCRIPTION");
    expect(descriptionDiff).toContain("-Next change");
    expect(descriptionDiff).toContain("+Renamed version");
    expect(descriptionDiff).toContain("+With details");
    const contentDiff = await repo.evolutionDiff(page.operationId, changed);
    expect(contentDiff).toContain("-hello from jj-evolved");
    expect(contentDiff).toContain("+changed content");
    expect(contentDiff).not.toContain("unsnapshotted content");
    expect(await repo.evolutionDiff(page.operationId, initial)).toContain("+Next change");
    expect(await repo.operationId()).toBe(operation);
    expect(await Bun.file(`${f.path}/hello.txt`).text()).toBe("unsnapshotted content\n");
  } finally { await f.cleanup(); }
});

test("evolution pagination stays at its original operation after external rewrites", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 52; i++) await f.jj("describe", "-m", `Version ${i}`);
    const repo = await Repository.open(f.path);
    const source = await revision(repo, "@");
    const first = await repo.evolution(source);
    expect(first.entries).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    await f.jj("describe", "-m", "External version");
    const operation = await repo.operationId();
    const more = await repo.evolution(source, { operationId: first.operationId, limit: 100 });
    expect(more.entries).toHaveLength(53);
    // An entry's time is how long ago its operation ran, worked out at each read, so it moves between the two reads.
    const withoutTime = (entries: typeof first.entries) => entries.map(({ time: _, ...rest }) => rest);
    expect(withoutTime(more.entries.slice(0, 50))).toEqual(withoutTime(first.entries));
    expect(more.entries.some(entry => entry.description.includes("External version"))).toBe(false);
    expect(more.hasMore).toBe(false);
    const entry = more.entries[50];
    if (!entry) throw new Error("Missing older entry");
    expect(await repo.evolutionDiff(more.operationId, entry)).toContain("JJ-COMMIT-DESCRIPTION");
    expect(await repo.operationId()).toBe(operation);
  } finally { await f.cleanup(); }
}, 15_000);

test("evolution compares a squash against its combined predecessors", async () => {
  const f = await fixture();
  try {
    await Bun.write(`${f.path}/other.txt`, "content from the second predecessor\n");
    await f.jj("squash", "--from", "@", "--into", "feature", "-m", "Combined");
    const repo = await Repository.open(f.path);
    const page = await repo.evolution(await revision(repo, "feature"));
    const entry = page.entries[0];
    if (!entry) throw new Error("Missing squashed version");
    const predecessors: unknown = JSON.parse(await f.jj("--at-op", page.operationId, "evolog", "-r", entry.commitId,
      "--limit", "1", "--no-graph", "-T", "json(predecessors.map(|p| p.commit_id()))"));
    expect(predecessors).toHaveLength(2);
    const patch = await repo.evolutionDiff(page.operationId, entry);
    expect(patch).toContain("+Combined");
    expect(patch).toContain("Initial feature");
    expect(patch).toContain("Next change");
    expect(patch).not.toContain("diff --git a/other.txt");
    expect(patch).not.toContain("diff --git a/hello.txt");
  } finally { await f.cleanup(); }
});
