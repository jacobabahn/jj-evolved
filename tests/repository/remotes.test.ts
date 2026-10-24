import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../src/repository/repository";
import { fetchReport, pushCaution, pushChanges } from "../../src/repository/remotes";
import { fixture } from "../fixture";

async function remoteFixture() {
  const f = await fixture();
  const remote = await mkdtemp(join(tmpdir(), "jj-remote-test-"));
  const proc = Bun.spawn(["git", "init", "--bare", remote], { stdout: "ignore", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
  await f.jj("git", "remote", "add", "origin", remote);
  const repo = await Repository.open(f.path);
  return { ...f, remote, repo, cleanup: async () => { await f.cleanup(); await rm(remote, { recursive: true, force: true }); } };
}
async function refs(path: string) {
  const proc = Bun.spawn(["git", "--git-dir", path, "for-each-ref", "--format=%(refname) %(objectname)"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

test("push review is read-only and publishes only its exact bookmark, then supports deletion", async () => {
  const f = await remoteFixture();
  try {
    await f.jj("bookmark", "create", "other", "-r", "feature");
    const before = await f.repo.operationId();
    const target = (await f.repo.bookmarks()).find(item => item.name === "feature")!.targets[0]!;
    const preview = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    expect(preview.summary).toContain(target);
    expect(preview.summary).toContain("Push only bookmark: feature");
    expect(await f.repo.operationId()).toBe(before);
    expect(await refs(f.remote)).toBe("");
    await f.repo.apply(preview);
    expect(await refs(f.remote)).toBe(`refs/heads/feature ${target}\n`);
    await f.jj("bookmark", "delete", "feature");
    const deletion = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    expect(deletion.summary).toContain("(delete remote bookmark)");
    await f.repo.apply(deletion);
    expect(await refs(f.remote)).toBe("");
  } finally { await f.cleanup(); }
});

test("fetch, untrack and track use reviewed remote names and preserve local bookmarks", async () => {
  const f = await remoteFixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-untrack", remote: "origin", name: "feature" }));
    expect((await f.repo.bookmarks()).find(item => item.remote === "origin")?.tracked).toBe(false);
    expect((await f.repo.bookmarks()).find(item => !item.remote && item.name === "feature")).toBeDefined();
    await f.repo.apply(await f.repo.prepare({ kind: "git-fetch", remote: "origin" }));
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-track", remote: "origin", name: "feature" }));
    expect((await f.repo.bookmarks()).find(item => item.remote === "origin")?.tracked).toBe(true);
    expect(await f.repo.remotes()).toEqual([{ name: "origin", url: f.remote }]);
  } finally { await f.cleanup(); }
});

test("push rejects stale local state and changed remote URLs without publishing", async () => {
  const f = await remoteFixture();
  try {
    const preview = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    await f.jj("describe", "-m", "Changed after review");
    await expect(f.repo.apply(preview)).rejects.toThrow("Repository changed");
    const fresh = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    await f.jj("git", "remote", "set-url", "origin", f.remote + "-missing");
    await expect(f.repo.apply(fresh)).rejects.toThrow("Remote configuration changed");
    expect(await refs(f.remote)).toBe("");
  } finally { await f.cleanup(); }
});

test("push reports remote rejection and preserves a concurrently changed remote", async () => {
  const f = await remoteFixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await f.jj("bookmark", "create", "other", "-r", "@");
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "other" }));
    await f.jj("new", "-m", "Local advancement");
    await f.jj("bookmark", "set", "feature", "-r", "@");
    const preview = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    const other = (await f.repo.bookmarks()).find(item => item.name === "other" && !item.remote)!.targets[0]!;
    const proc = Bun.spawn(["git", "--git-dir", f.remote, "update-ref", "refs/heads/feature", other]);
    expect(await proc.exited).toBe(0);
    await expect(f.repo.apply(preview)).rejects.toThrow("fetch and push again");
    expect(await refs(f.remote)).toContain(`refs/heads/feature ${other}`);
  } finally { await f.cleanup(); }
});

test("missing and inaccessible remotes surface useful errors", async () => {
  const f = await remoteFixture();
  try {
    await expect(f.repo.prepare({ kind: "git-fetch", remote: "missing" })).rejects.toThrow("no longer exists");
    await f.jj("git", "remote", "set-url", "origin", f.remote + "-missing");
    await expect(f.repo.apply(await f.repo.prepare({ kind: "git-fetch", remote: "origin" }))).rejects.toThrow("configure Git credentials or SSH");
  } finally { await f.cleanup(); }
});

test("fetch imports a tracked remote advancement while preserving working-copy files", async () => {
  const f = await remoteFixture();
  const publisher = await fixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await publisher.jj("bookmark", "delete", "feature");
    await publisher.jj("git", "remote", "add", "origin", f.remote);
    await publisher.jj("git", "fetch", "--remote", "origin");
    await publisher.jj("bookmark", "track", "feature@origin");
    await publisher.jj("new", "feature", "-m", "Remote advancement");
    await Bun.write(join(publisher.path, "hello.txt"), "published content\n");
    await publisher.jj("bookmark", "set", "feature", "-r", "@");
    await publisher.jj("git", "push", "--remote", "origin", "--bookmark", "exact:feature");
    await Bun.write(join(f.path, "local.txt"), "unpublished working copy\n");
    const prepared = await f.repo.prepare({ kind: "git-fetch", remote: "origin" });
    await f.repo.apply(prepared);
    await f.repo.status();
    const fetched = (await f.repo.snapshot("feature")).revisions[0]!;
    expect(fetched.description.trim()).toBe("Remote advancement");
    expect(await f.repo.diff(fetched)).toContain("+published content");
    expect(await Bun.file(join(f.path, "local.txt")).text()).toBe("unpublished working copy\n");
    expect(await Bun.file(join(f.path, "hello.txt")).text()).toBe("hello from jj-evolved\n");
  } finally { await f.cleanup(); await publisher.cleanup(); }
});

test("publish creates a bookmark on the change, tracks it and pushes, with a read-only preview", async () => {
  const f = await remoteFixture();
  try {
    const revision = (await f.repo.snapshot("@")).revisions[0]!;
    const before = await f.repo.operationId();
    const preview = await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "next", revision });
    expect(preview.summary).toContain("Bookmark: next (create)");
    expect(preview.summary).toContain("Tracking: start tracking next@origin");
    expect(preview.summary).toContain(`add next@origin at ${revision.commitId}`);
    expect(preview.summary).toContain("Commits to publish (2):");
    expect(await f.repo.operationId()).toBe(before);
    expect(await refs(f.remote)).toBe("");
    await f.repo.apply(preview);
    expect(await refs(f.remote)).toBe(`refs/heads/next ${revision.commitId}\n`);
    const bookmarks = await f.repo.bookmarks();
    expect(bookmarks.find(item => item.name === "next" && !item.remote)?.targets).toEqual([revision.commitId]);
    expect(bookmarks.find(item => item.name === "next" && item.remote === "origin")?.tracked).toBe(true);
    const again = await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "next", revision });
    expect(again.summary).toContain("already on this change");
    expect(again.summary).toContain("remote is already up to date");
    expect(again.summary).toContain("No new commits to publish.");
  } finally { await f.cleanup(); }
});

test("publish moves an existing bookmark to the change and advances the tracked remote", async () => {
  const f = await remoteFixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    const old = (await f.repo.bookmarks()).find(item => item.name === "feature" && !item.remote)!.targets[0]!;
    const revision = (await f.repo.snapshot("@")).revisions[0]!;
    const preview = await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "feature", revision });
    expect(preview.summary).toContain(`Advance bookmark feature by 1 commit to this change, then push it.\n  from ${old}\n  to   ${revision.commitId}`);
    expect(preview.summary).toContain("Bookmark: feature (advance 1 commit)");
    expect(preview.summary).toContain("Tracking: already tracking feature@origin");
    expect(preview.summary).toContain(`move feature@origin from ${old} to ${revision.commitId}`);
    expect(preview.summary).toContain("Commits to publish (1):");
    await f.repo.apply(preview);
    expect(await refs(f.remote)).toBe(`refs/heads/feature ${revision.commitId}\n`);
    // Moving it back is not an advance, and is reviewed as a plain move.
    const parent = (await f.repo.snapshot("@-")).revisions[0]!;
    const back = await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "feature", revision: parent });
    expect(back.summary).toContain(`Bookmark: feature (move from ${revision.commitId})`);
    expect(back.summary).not.toContain("Advance bookmark");
    // Publishing applies at once like any push, so moving the remote bookmark backward or sideways must stop for review.
    expect(preview.caution).toBeUndefined();
    expect(back.caution).toContain("moves feature@origin backward");
    expect(back.summary).toStartWith("Warning: This moves feature@origin backward");
    await f.jj("new", parent.commitId, "-m", "Side change");
    const side = (await f.repo.snapshot("@")).revisions[0]!;
    const sideways = await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "feature", revision: side });
    expect(sideways.caution).toContain("moves feature@origin sideways");
    expect((await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "fresh", revision: side })).caution).toBeUndefined();
  } finally { await f.cleanup(); }
});

test("publish infers the bookmark on the change, then on the nearest mutable ancestor, and never an immutable one", async () => {
  const f = await remoteFixture();
  try {
    const infer = async (revset: string) => f.repo.publishBookmarks((await f.repo.snapshot(revset)).revisions[0]!, await f.repo.bookmarks());
    expect(await infer("feature")).toEqual({ names: ["feature"], advance: false });
    expect(await infer("@")).toEqual({ names: ["feature"], advance: true });
    await f.jj("new", "-m", "Third change");
    await f.jj("bookmark", "create", "aaa", "-r", "feature");
    expect(await infer("@")).toEqual({ names: ["aaa", "feature"], advance: true });
    await f.jj("bookmark", "create", "nearer", "-r", "@-");
    expect(await infer("@")).toEqual({ names: ["nearer"], advance: true });
    // Pushing main makes it trunk, so it and the bookmarks beside it are immutable.
    await f.jj("bookmark", "delete", "nearer");
    await f.jj("bookmark", "create", "main", "-r", "feature");
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "main" }));
    expect(await infer("@")).toEqual({ names: [], advance: true });
  } finally { await f.cleanup(); }
});

test("the suggested bookmark name follows templates.git_push_bookmark", async () => {
  const f = await remoteFixture();
  try {
    const revision = (await f.repo.snapshot("@")).revisions[0]!;
    expect(await f.repo.generatedBookmarkName(revision)).toBe(`push-${revision.changeId.slice(0, 12)}`);
    await f.jj("config", "set", "--repo", "templates.git_push_bookmark", `'"me/" ++ change_id.short(6)'`);
    expect(await f.repo.generatedBookmarkName(revision)).toBe(`me/${revision.changeId.slice(0, 6)}`);
  } finally { await f.cleanup(); }
});

test("publish refuses changes JJ will not push, untracked remote names and empty names before writing", async () => {
  const f = await remoteFixture();
  try {
    await f.jj("new");
    const undescribed = (await f.repo.snapshot("@")).revisions[0]!;
    const before = await f.repo.operationId();
    await expect(f.repo.prepare({ kind: "git-publish", remote: "origin", name: "wip", revision: undescribed })).rejects.toThrow("has no description");
    await expect(f.repo.prepare({ kind: "git-publish", remote: "origin", name: "", revision: undescribed })).rejects.toThrow("Enter a bookmark name");
    expect(await f.repo.operationId()).toBe(before);
    expect((await f.repo.bookmarks()).some(item => item.name === "wip")).toBe(false);
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await f.jj("bookmark", "untrack", "feature", "--remote", "origin");
    const revision = (await f.repo.snapshot("@-")).revisions[0]!;
    await expect(f.repo.prepare({ kind: "git-publish", remote: "origin", name: "feature", revision })).rejects.toThrow("is not tracked");
  } finally { await f.cleanup(); }
});

test("a failed publish keeps the tracked local bookmark so it can be retried", async () => {
  const f = await remoteFixture();
  try {
    const revision = (await f.repo.snapshot("@")).revisions[0]!;
    const preview = await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "next", revision });
    await rm(f.remote, { recursive: true, force: true });
    await expect(f.repo.apply(preview)).rejects.toThrow("only the push failed");
    expect((await f.repo.bookmarks()).find(item => item.name === "next" && !item.remote)?.targets).toEqual([revision.commitId]);
  } finally { await f.cleanup(); }
});

test("bookmarks report ahead and behind counts for tracked remotes and mark local-only bookmarks", async () => {
  const f = await remoteFixture();
  const plain = await fixture();
  try {
    const state = async () => {
      const bookmarks = await f.repo.bookmarks();
      const { ahead, behind } = bookmarks.find(item => item.name === "feature" && item.remote === "origin") ?? {};
      return { ahead, behind, localOnly: bookmarks.filter(item => item.localOnly).map(item => `${item.name}@${item.remote}`) };
    };
    expect(await state()).toEqual({ ahead: undefined, behind: undefined, localOnly: ["feature@"] });
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await f.jj("bookmark", "create", "solo", "-r", "@");
    expect(await state()).toEqual({ ahead: 0, behind: 0, localOnly: ["solo@"] });
    await f.jj("new", "-m", "Third change");
    await f.jj("bookmark", "set", "feature", "-r", "@");
    expect(await state()).toEqual({ ahead: 2, behind: 0, localOnly: ["solo@"] });
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await f.jj("bookmark", "set", "feature", "-r", "@--", "--allow-backwards");
    expect(await state()).toEqual({ ahead: 0, behind: 2, localOnly: ["solo@"] });
    await f.jj("new", "@--", "-m", "Side change");
    await f.jj("bookmark", "set", "feature", "-r", "@");
    expect(await state()).toEqual({ ahead: 1, behind: 2, localOnly: ["solo@"] });
    // An untracked remote bookmark has no counts, but the name is on the remote, so the local bookmark is not unpushed.
    await f.jj("bookmark", "untrack", "feature", "--remote", "origin");
    expect(await state()).toEqual({ ahead: undefined, behind: undefined, localOnly: ["solo@"] });
    // Without a remote there is nowhere to push to, so nothing is marked.
    expect((await (await Repository.open(plain.path)).bookmarks()).some(item => item.localOnly)).toBe(false);
  } finally { await f.cleanup(); await plain.cleanup(); }
});

test("a local bookmark created beside a fetched, untracked remote bookmark is not marked unpushed", async () => {
  const f = await remoteFixture();
  const publisher = await fixture();
  try {
    await publisher.jj("git", "remote", "add", "origin", f.remote);
    await publisher.jj("bookmark", "create", "topic", "-r", "@-");
    await publisher.jj("git", "push", "--remote", "origin", "--bookmark", "exact:topic");
    await f.jj("git", "fetch", "--remote", "origin");
    const remote = (await f.repo.bookmarks()).find(item => item.name === "topic" && item.remote === "origin")!;
    expect(remote.tracked).toBe(false);
    await f.jj("bookmark", "create", "topic", "-r", remote.targets[0]!);
    const local = (await f.repo.bookmarks()).find(item => item.name === "topic" && !item.remote)!;
    expect(local.targets).toEqual(remote.targets);
    expect(local.localOnly).toBeUndefined();
  } finally { await f.cleanup(); await publisher.cleanup(); }
});

test("deleting a tracked bookmark stays local by default and can also delete it on the remote", async () => {
  const f = await remoteFixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    const target = (await f.repo.bookmarks()).find(item => item.name === "feature" && !item.remote)!.targets[0]!;
    const localOnly = await f.repo.prepare({ kind: "bookmark-delete", name: "feature", remote: "origin" });
    expect(localOnly.summary).toContain("Local deletion only. feature@origin stays on the remote");
    const before = await f.repo.operationId();
    const both = await f.repo.prepare({ kind: "bookmark-delete", name: "feature", remote: "origin", push: true });
    expect(both.summary).toContain(`delete feature@origin, last fetched at ${target}`);
    expect(both.summary).toContain("cannot be undone locally");
    expect(await f.repo.operationId()).toBe(before);
    expect(await refs(f.remote)).toBe(`refs/heads/feature ${target}\n`);
    await f.repo.apply(both);
    expect(await refs(f.remote)).toBe("");
    expect((await f.repo.bookmarks()).some(item => item.name === "feature")).toBe(false);
    await f.jj("bookmark", "create", "feature", "-r", target);
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-delete", name: "feature", remote: "origin" }));
    expect(await refs(f.remote)).toBe(`refs/heads/feature ${target}\n`);
    expect((await f.repo.bookmarks()).find(item => item.name === "feature" && item.remote === "origin")).toMatchObject({ tracked: true, targets: [target] });
    await expect(f.repo.prepare({ kind: "bookmark-delete", name: "solo", remote: "origin", push: true })).rejects.toThrow("no longer exists");
  } finally { await f.cleanup(); }
});

test("a failed remote deletion reports that the local bookmark is gone and how to retry", async () => {
  const f = await remoteFixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    const preview = await f.repo.prepare({ kind: "bookmark-delete", name: "feature", remote: "origin", push: true });
    await rm(f.remote, { recursive: true, force: true });
    const failure = f.repo.apply(preview);
    await expect(failure).rejects.toThrow("The local bookmark feature was deleted, but feature@origin still exists; only the push failed.");
    await expect(failure).rejects.toThrow("Push deletion");
    const bookmarks = await f.repo.bookmarks();
    expect(bookmarks.find(item => item.name === "feature" && !item.remote)?.targets ?? []).toEqual([]);
    expect(bookmarks.find(item => item.name === "feature" && item.remote === "origin")?.tracked).toBe(true);
  } finally { await f.cleanup(); }
});

test("syncing with trunk rebases the whole stack after a fetch and explains when there is nothing to rebase", async () => {
  const f = await remoteFixture();
  const publisher = await fixture();
  try {
    await f.jj("bookmark", "create", "main", "-r", "feature");
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "main" }));
    await f.jj("new", "-m", "Top of the stack");
    const top = async () => (await f.repo.snapshot("@")).revisions[0]!;
    expect(await f.repo.trunkRebase(await top())).toMatchObject({ kind: "current", reason: expect.stringContaining("Already based on trunk") });
    await publisher.jj("git", "remote", "add", "origin", f.remote);
    await publisher.jj("git", "fetch", "--remote", "origin");
    await publisher.jj("bookmark", "track", "main@origin");
    await publisher.jj("new", "main", "-m", "Upstream work");
    await publisher.jj("bookmark", "set", "main", "-r", "@");
    await publisher.jj("git", "push", "--remote", "origin", "--bookmark", "exact:main");
    await f.repo.apply(await f.repo.prepare({ kind: "git-fetch", remote: "origin" }));
    const [trunk] = await f.repo.navigationRevisions("trunk()");
    const [root] = await f.repo.navigationRevisions("@-");
    expect(trunk!.description.trim()).toBe("Upstream work");
    // The selected change is the top of the stack; the rebase starts at the stack's root, as jj rebase -b does.
    const plan = await f.repo.trunkRebase(await top());
    expect(plan).toMatchObject({ kind: "rebase", action: { kind: "rebase", descendants: true, revision: { commitId: root!.commitId }, destination: { commitId: trunk!.commitId } } });
    if (plan.kind !== "rebase") throw new Error("Expected a rebase");
    await f.repo.apply(await f.repo.prepare(plan.action));
    expect((await f.repo.navigationRevisions("@-"))[0]!.parents).toEqual([trunk!.commitId]);
    expect((await f.repo.trunkRebase(await top())).kind).toBe("current");
    expect(await f.repo.trunkRebase(trunk!)).toMatchObject({ kind: "blocked", reason: expect.stringContaining("is trunk itself") });
    const [old] = await f.repo.navigationRevisions("trunk()-");
    expect(await f.repo.trunkRebase(old!)).toMatchObject({ kind: "blocked", reason: expect.stringContaining("is immutable") });
    await f.jj("bookmark", "create", "stack", "-r", "@");
    await f.jj("new", "root()", "-m", "Unrelated root");
    await f.jj("new", "@", "stack", "-m", "Merge of two stacks");
    expect(await f.repo.trunkRebase(await top())).toMatchObject({ kind: "blocked", reason: expect.stringContaining("2 roots") });
  } finally { await f.cleanup(); await publisher.cleanup(); }
});

test("the default push remote follows git.push, then origin, then a lone remote", async () => {
  const f = await remoteFixture();
  try {
    const origin = { name: "origin", url: f.remote };
    expect(await f.repo.defaultPushRemote([origin])).toEqual(origin);
    await f.jj("git", "remote", "add", "fork", f.remote);
    expect(await f.repo.defaultPushRemote(await f.repo.remotes())).toEqual(origin);
    await f.jj("config", "set", "--repo", "git.push", "fork");
    expect((await f.repo.defaultPushRemote(await f.repo.remotes()))?.name).toBe("fork");
    await f.jj("config", "unset", "--repo", "git.push");
    await f.jj("git", "remote", "rename", "origin", "upstream");
    expect(await f.repo.defaultPushRemote(await f.repo.remotes())).toBeUndefined();
    expect((await f.repo.defaultPushRemote([{ name: "upstream", url: f.remote }]))?.name).toBe("upstream");
  } finally { await f.cleanup(); }
});

test("pushes that delete or drop commits from a remote bookmark carry a caution; forward pushes do not", async () => {
  const f = await remoteFixture();
  try {
    const added = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    expect(added.caution).toBeUndefined();
    expect(await f.repo.apply(added)).toMatch(/^Pushed feature to origin\nadded at [0-9a-f]{8}$/);
    await f.jj("bookmark", "set", "feature", "-r", "@");
    const forward = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    expect(forward.caution).toBeUndefined();
    expect(await f.repo.apply(forward)).toMatch(/^Pushed feature to origin\nmoved forward [0-9a-f]{8} → [0-9a-f]{8}$/);
    await f.jj("bookmark", "set", "feature", "--allow-backwards", "-r", "@-");
    const backward = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    expect(backward.caution).toContain("moves feature@origin backward");
    expect(backward.summary).toStartWith("Warning: This moves feature@origin backward");
    await f.jj("bookmark", "delete", "feature");
    const deletion = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    expect(deletion.caution).toBe("This deletes feature on origin.");
    expect(await f.repo.apply(deletion)).toMatch(/^Pushed feature to origin\ndeleted \(was [0-9a-f]{8}\)$/);
  } finally { await f.cleanup(); }
});

test("a non-ASCII bookmark, which jj quotes in push output, still stops for review before its deletion", async () => {
  const f = await remoteFixture();
  try {
    await f.jj("bookmark", "create", "é", "-r", "feature");
    const added = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "é" });
    expect(added.summary).toContain('bookmark: "é" [add to');
    expect(added.caution).toBeUndefined();
    expect(await f.repo.apply(added)).toMatch(/^Pushed é to origin\nadded at [0-9a-f]{8}$/);
    expect(await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "é" }))).toBe("é is already up to date on origin");
    await f.jj("bookmark", "delete", "é");
    const deletion = await f.repo.prepare({ kind: "git-push", remote: "origin", name: "é" });
    expect(deletion.caution).toBe("This deletes é on origin.");
    expect(await f.repo.apply(deletion)).toMatch(/^Pushed é to origin\ndeleted \(was [0-9a-f]{8}\)$/);
    expect(await refs(f.remote)).not.toContain("refs/heads/");
  } finally { await f.cleanup(); }
});

test("fetch and push report when there was nothing to do", async () => {
  const f = await remoteFixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    expect(await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }))).toBe("feature is already up to date on origin");
    expect(await f.repo.apply(await f.repo.prepare({ kind: "git-fetch", remote: "origin" }))).toBe("Fetched origin\nalready up to date");
  } finally { await f.cleanup(); }
});

test("push and fetch output parse into changes and reports", () => {
  expect(pushChanges("Changes to push to origin:\n  bookmark: main [move sideways from 1b233ebc90ae to da0e4cdd6b90]\n  bookmark: other [add to da0e4cdd6b90]\nDry-run requested, not pushing.")).toEqual([
    { name: "main", kind: "sideways", from: "1b233ebc90ae", to: "da0e4cdd6b90" },
    { name: "other", kind: "add", to: "da0e4cdd6b90" },
  ]);
  expect(fetchReport("origin", "bookmark: main@origin [updated] tracked\nbookmark: newb@origin [new] untracked\n")).toBe("Fetched origin · 2 bookmarks changed\nmain updated, newb new");
  expect(pushChanges('  bookmark: "é" [delete from e7dba9d55b13]\n  bookmark: "a \\"b\\"" [add to da0e4cdd6b90]\n  bookmark: feat+x [add to da0e4cdd6b90]')).toEqual([
    { name: "é", kind: "delete", from: "e7dba9d55b13" },
    { name: 'a "b"', kind: "add", to: "da0e4cdd6b90" },
    { name: "feat+x", kind: "add", to: "da0e4cdd6b90" },
  ]);
  expect(fetchReport("origin", 'bookmark: "ü"@origin [new] untracked\n')).toBe("Fetched origin · 1 bookmark changed\nü new");
  expect(fetchReport("origin", "bookmark: a@origin [new] untracked\nbookmark: b@origin [new] untracked\nbookmark: c@origin [new] untracked\nbookmark: d@origin [deleted] untracked\n"))
    .toBe("Fetched origin · 4 bookmarks changed\na new, b new, c new, +1 more");
});

test("a push dry run that does not show the bookmark's change stops for review", () => {
  expect(pushCaution("feature", "origin", "Bookmark feature@origin already matches feature\nNothing changed.\n")).toBeUndefined();
  expect(pushCaution("feature", "origin", "Changes to push to origin:\n  bookmark: other [add to da0e4cdd6b90]\n")).toContain("does not say how this push changes feature@origin");
  expect(pushCaution("feature", "origin", "Changes to push to origin:\n  bookmark: feature [rewrite e7dba9d55b13]\n")).toContain("does not say how this push changes feature@origin");
});

test("only fetch and push commands can be cancelled, not tracking changes or local preparation", async () => {
  const f = await remoteFixture();
  // Samples networkActive while the work runs; each step spawns jj, which takes far longer than a millisecond.
  const cancellable = async <T>(work: Promise<T>) => {
    let done = false, seen = false;
    void work.finally(() => { done = true; }).catch(() => {});
    while (!done) { seen ||= f.repo.networkActive; await Bun.sleep(1); }
    return { seen, result: await work };
  };
  try {
    const dryRun = await cancellable(f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    expect(dryRun.seen).toBe(true);
    expect((await cancellable(f.repo.apply(dryRun.result))).seen).toBe(true);
    const untrack = await cancellable(f.repo.prepare({ kind: "bookmark-untrack", remote: "origin", name: "feature" }));
    expect(untrack.seen).toBe(false);
    expect((await cancellable(f.repo.apply(untrack.result))).seen).toBe(false);
    expect((await cancellable(f.repo.prepare({ kind: "git-fetch", remote: "origin" }))).seen).toBe(false);
  } finally { await f.cleanup(); }
});

test("cancelling a publish during its local steps stops the push before it starts", async () => {
  const f = await remoteFixture();
  try {
    const revision = (await f.repo.snapshot("@")).revisions[0]!;
    const applying = f.repo.apply(await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "next", revision }));
    for (let attempt = 0; attempt < 1000 && !f.repo.networkActive; attempt++) await Bun.sleep(1);
    f.repo.cancelNetwork();
    await expect(applying).rejects.toThrow("Publish cancelled before the push started; nothing was sent to origin.\nThe local bookmark next is set and tracks origin. Publish again to push it.");
    expect(await refs(f.remote)).toBe("");
    expect((await f.repo.bookmarks()).find(item => item.name === "next" && !item.remote)?.targets).toEqual([revision.commitId]);
  } finally { await f.cleanup(); }
});

test("cancelNetwork stops a fetch that is waiting on the remote", async () => {
  const f = await remoteFixture();
  const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
  // An ext:: remote whose transport never answers stands in for a stalled connection.
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.ext.allow", GIT_CONFIG_VALUE_0: "always" });
  try {
    await f.jj("git", "remote", "add", "slow", "ext::sleep 30");
    const prepared = await f.repo.prepare({ kind: "git-fetch", remote: "slow" });
    const started = performance.now();
    const applying = f.repo.apply(prepared);
    await Bun.sleep(300);
    expect(f.repo.networkActive).toBe(true);
    f.repo.cancelNetwork();
    await expect(applying).rejects.toThrow("Fetch cancelled.");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(f.repo.networkActive).toBe(false);
  } finally {
    for (const [key, value] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await f.cleanup();
  }
}, 40_000);
