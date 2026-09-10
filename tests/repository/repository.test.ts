import { expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Repository } from "../../src/repository/repository";
import { fixture } from "../fixture";

test("reads real history, bookmarks, parents, diffs, status and revsets", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.path, "nested"));
    const repo = await Repository.open(join(f.path, "nested"));
    expect(repo.root).toBe(await realpath(f.path));
    const snapshot = await repo.snapshot("all()");
    expect(snapshot.revisions).toHaveLength(3);
    const current = snapshot.revisions.find(r => r.workingCopy);
    const initial = snapshot.revisions.find(r => r.description.startsWith("Initial"));
    if (!initial || !current) throw new Error("Expected fixture revisions");
    expect(initial.bookmarks).toContain("feature");
    expect(current.parents).toContain(initial.commitId);
    expect(await repo.diff(initial)).toContain("+hello from jj-evolved");
    expect(await repo.diff(current)).toBe("");
    expect(await repo.status()).toContain("Working copy");
    expect((await repo.snapshot("none()")).revisions).toEqual([]);
    expect((await repo.snapshot("@")).revisions).toHaveLength(1);
    await expect(repo.snapshot("invalid(((")).rejects.toThrow();
  } finally { await f.cleanup(); }
});

test("describes literal text and creates a real child change", async () => {
  const f = await fixture();
  try {
    const repo = await Repository.open(f.path);
    const current = (await repo.snapshot("@")).revisions[0];
    if (!current) throw new Error("Expected current revision");
    const description = "Quotes \" ' and $(touch should-not-exist); `echo hi`\nsecond line\ttext";
    await repo.apply(await repo.prepare({ kind: "describe", revision: current, description }));
    const described = (await repo.snapshot("@")).revisions[0];
    if (!described) throw new Error("Expected described revision");
    expect(described.description.trim()).toBe(description);
    expect(described.changeId).toBe(current.changeId);
    expect(await Bun.file(join(f.path, "should-not-exist")).exists()).toBe(false);
    await repo.apply(await repo.prepare({ kind: "new", parent: described }));
    const child = (await repo.snapshot("@")).revisions[0];
    expect(child?.parents).toContain(described.commitId);
    expect(child?.changeId).not.toBe(described.changeId);
  } finally { await f.cleanup(); }
});

test("surfaces a non-repository error", async () => {
  await expect(Repository.open("/tmp")).rejects.toThrow();
});

test("short change prefixes come from JJ and resolve beyond the filtered graph", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 17; index++) await f.jj("new", "-m", `Prefix collision ${index}`);
    const repo = await Repository.open(f.path);
    const all = await repo.snapshot("all()");
    const collision = all.revisions.find(revision => revision.changePrefix.length > 1);
    if (!collision) throw new Error("Expected two changes sharing an initial letter");
    for (const revision of all.revisions) {
      const expected = await f.jj("log", "--no-graph", "-r", revision.commitId, "-T", "change_id.shortest().prefix()");
      expect(revision.changePrefix).toBe(expected);
      const resolved = await f.jj("log", "--no-graph", "-r", revision.changePrefix, "-T", "change_id");
      expect(resolved).toBe(revision.changeId);
    }
    const filtered = await repo.snapshot(collision.commitId);
    expect(filtered.revisions).toHaveLength(1);
    expect(filtered.revisions[0]?.changePrefix).toBe(collision.changePrefix);
  } finally { await f.cleanup(); }
}, 15_000);
