import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../src/repository/repository";
import { fetchAllReport, fetchReport, pushCaution, pushChanges, remoteFailureHint } from "../../src/repository/remotes";
import { pushRoute } from "../../src/repository/model";
import { newBookmarkName } from "../../src/repository/mutation";
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

test("publish never infers a conflicted bookmark, which the push would refuse", async () => {
  const f = await remoteFixture();
  const publisher = await fixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await publisher.jj("bookmark", "forget", "feature");
    await publisher.jj("git", "remote", "add", "origin", f.remote);
    await publisher.jj("git", "fetch", "--remote", "origin");
    await publisher.jj("bookmark", "track", "feature", "--remote", "origin");
    await publisher.jj("new", "feature", "-m", "Upstream work");
    await publisher.jj("bookmark", "set", "feature", "-r", "@");
    await publisher.jj("git", "push", "--remote", "origin", "--bookmark", "exact:feature");
    // The local bookmark moves one way and the remote another, so the fetch leaves feature conflicted.
    await f.jj("bookmark", "set", "feature", "-r", "@");
    await f.jj("git", "fetch", "--remote", "origin");
    const bookmarks = await f.repo.bookmarks();
    expect(bookmarks.find(item => item.name === "feature" && !item.remote)?.conflict).toBe(true);
    const revision = (await f.repo.snapshot("@")).revisions[0]!;
    expect(await f.repo.publishBookmarks(revision, bookmarks)).toEqual({ names: [], advance: true });
    await f.jj("new", "-m", "On top");
    expect(await f.repo.publishBookmarks((await f.repo.snapshot("@")).revisions[0]!, await f.repo.bookmarks())).toEqual({ names: [], advance: true });
  } finally { await f.cleanup(); await publisher.cleanup(); }
});

// Puts a jj on PATH that runs the real one, then writes a bookmark from "another process" right after any command whose
// arguments include `trigger`, which is the window between a publish's local step and its push.
async function withIntruder<T>(trigger: string, work: () => Promise<T>): Promise<T> {
  const real = Bun.which("jj")!;
  const dir = await mkdtemp(join(tmpdir(), "jj-intruder-"));
  await Bun.write(join(dir, "jj"), `#!/bin/sh\n"${real}" "$@"\ncode=$?\ncase " $* " in *" ${trigger} "*) "${real}" --ignore-working-copy bookmark create intruder -r @ >/dev/null 2>&1;; esac\nexit $code\n`);
  await Bun.$`chmod +x ${join(dir, "jj")}`.quiet();
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try { return await work(); } finally { process.env.PATH = path; await rm(dir, { recursive: true, force: true }); }
}

test("a publish or remote deletion refuses to push when another jj command writes after its local step", async () => {
  const f = await remoteFixture();
  try {
    const revision = (await f.repo.snapshot("@")).revisions[0]!;
    const publish = await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "next", revision });
    await withIntruder("create", async () => { await expect(f.repo.apply(publish)).rejects.toThrow("Another jj command changed the repository during this publish, so nothing was pushed to origin."); });
    expect(await refs(f.remote)).toBe("");
    const bookmarks = await f.repo.bookmarks();
    expect(bookmarks.find(item => item.name === "next" && !item.remote)?.targets).toEqual([revision.commitId]);
    expect(bookmarks.some(item => item.name === "intruder")).toBe(true);
    // Without the intruder, publishing again pushes.
    await f.jj("bookmark", "delete", "intruder");
    await f.repo.apply(await f.repo.prepare({ kind: "git-publish", remote: "origin", name: "next", revision }));
    expect(await refs(f.remote)).toBe(`refs/heads/next ${revision.commitId}\n`);
    await f.jj("bookmark", "delete", "intruder");
    const deletion = await f.repo.prepare({ kind: "bookmark-delete", name: "next", remote: "origin", push: true });
    await withIntruder("delete", async () => { await expect(f.repo.apply(deletion)).rejects.toThrow("Another jj command changed the repository during this deletion, so nothing was pushed to origin."); });
    expect(await refs(f.remote)).toBe(`refs/heads/next ${revision.commitId}\n`);
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
    expect(both.summary).toContain("undo reverts the push, which changes nothing here");
    expect(await f.repo.operationId()).toBe(before);
    expect(await refs(f.remote)).toBe(`refs/heads/feature ${target}\n`);
    expect(await f.repo.apply(both)).toMatch(/^Deleted feature here and on origin\nwas [0-9a-f]{8}$/);
    expect(await refs(f.remote)).toBe("");
    expect((await f.repo.bookmarks()).some(item => item.name === "feature")).toBe(false);
    // What the review says about recovery: undo reverts only the push and leaves the bookmark deleted,
    // while restoring the operation before the deletion brings the local bookmark back.
    const [push, deletion, previous] = await f.repo.operations(3);
    expect(deletion!.description).toBe("delete bookmark feature");
    await f.repo.apply(await f.repo.prepare({ kind: "undo", operation: push! }));
    expect((await f.repo.bookmarks()).some(item => item.name === "feature")).toBe(false);
    await f.repo.apply(await f.repo.prepare({ kind: "restore", operation: previous! }));
    expect((await f.repo.bookmarks()).find(item => item.name === "feature" && !item.remote)?.targets).toEqual([target]);
    expect(await refs(f.remote)).toBe("");
    await f.jj("bookmark", "delete", "feature");
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
    const top = async () => (await f.repo.snapshot("@")).revisions[0]!;
    // trunk() falls back to root() without a trunk bookmark; that is reported, not taken as being based on trunk.
    expect(await f.repo.trunkRebase(await top())).toEqual({ kind: "no-trunk", reason: "No trunk bookmark found, so there is nothing to rebase onto." });
    await f.jj("bookmark", "create", "main", "-r", "feature");
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "main" }));
    await f.jj("new", "-m", "Top of the stack");
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

test("bookmark names with revset operators act on exactly the named bookmark", async () => {
  const f = await remoteFixture();
  try {
    const revision = (await f.repo.snapshot("feature")).revisions[0]!;
    // `a` and `b` exist too, so an unquoted `a|b` or `a&b` would reach them instead.
    for (const name of ["a", "b", "a|b", "a&b", "a@b", "p(q)", "o'k"]) await f.repo.apply(await f.repo.prepare({ kind: "bookmark-create", name, revision }));
    const local = async () => (await f.repo.bookmarks()).filter(item => !item.remote).map(item => item.name).sort();
    expect(await local()).toEqual(["a", "a&b", "a@b", "a|b", "b", "feature", "o'k", "p(q)"].sort());
    for (const name of ["a|b", "a&b", "a@b"]) {
      const preview = await f.repo.prepare({ kind: "git-push", remote: "origin", name });
      expect(preview.caution).toBeUndefined();
      expect(await f.repo.apply(preview)).toMatch(new RegExp(`^Pushed ${name.replace(/[|&]/g, "\\$&")} to origin\nadded at [0-9a-f]{8}$`));
    }
    expect((await refs(f.remote)).split("\n").filter(Boolean).map(line => line.split(" ")[0]).sort()).toEqual(["refs/heads/a&b", "refs/heads/a@b", "refs/heads/a|b"]);
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-untrack", remote: "origin", name: "a|b" }));
    expect((await f.repo.bookmarks()).find(item => item.remote === "origin" && item.name === "a|b")?.tracked).toBe(false);
    expect((await f.repo.bookmarks()).find(item => item.remote === "origin" && item.name === "a&b")?.tracked).toBe(true);
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-track", remote: "origin", name: "a|b" }));
    expect((await f.repo.bookmarks()).find(item => item.remote === "origin" && item.name === "a|b")?.tracked).toBe(true);
    const next = (await f.repo.snapshot("@")).revisions[0]!;
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-move", name: "a&b", revision: next }));
    expect((await f.repo.bookmarks()).find(item => !item.remote && item.name === "a&b")?.targets).toEqual([next.commitId]);
    expect((await f.repo.bookmarks()).find(item => !item.remote && item.name === "a")?.targets).toEqual([revision.commitId]);
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-rename", name: "p(q)", newName: "c,d" }));
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-delete", name: "o'k" }));
    await f.repo.apply(await f.repo.prepare({ kind: "bookmark-delete", name: "a|b", remote: "origin", push: true }));
    expect(await local()).toEqual(["a", "a&b", "a@b", "b", "c,d", "feature"].sort());
    expect((await refs(f.remote)).split("\n").filter(Boolean).map(line => line.split(" ")[0]).sort()).toEqual(["refs/heads/a&b", "refs/heads/a@b"]);
  } finally { await f.cleanup(); }
});

test("a new bookmark name is refused when Git could not store it", () => {
  for (const name of ["a|b", "a&b", "a@b", "p(q)", "o'k", "c,d", "é", "team/feature"]) expect(newBookmarkName(name)).toBe(JSON.stringify(name));
  for (const name of ["", "bad name", "a..b", "x~y", "a:b", "a^b", "a?b", "a*b", "a[b", "a\\b", "@", "a@{1}", "-x", ".hid", "a/.b", "a//b", "a/", "x.lock", "a."])
    expect(() => newBookmarkName(name)).toThrow("Git cannot use the bookmark name");
});

async function secondRemote(f: { jj: (...args: string[]) => Promise<string> }, name: string) {
  const path = await mkdtemp(join(tmpdir(), "jj-remote-test-"));
  const proc = Bun.spawn(["git", "init", "--bare", path], { stdout: "ignore", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
  await f.jj("git", "remote", "add", name, path);
  return path;
}

test("a bookmark tracking another remote is pushed through a publish that tracks it first", async () => {
  const f = await remoteFixture();
  const up = await secondRemote(f, "up");
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    const target = (await f.repo.bookmarks()).find(item => item.name === "feature" && !item.remote)!.targets[0]!;
    expect(pushRoute("feature", "up", await f.repo.bookmarks())).toEqual({ kind: "publish", commitId: target, tracking: ["origin"] });
    expect(pushRoute("feature", "origin", await f.repo.bookmarks())).toEqual({ kind: "push" });
    // jj itself would refuse at the dry run with "Refusing to create new remote bookmark feature@up".
    const refused = f.repo.prepare({ kind: "git-push", remote: "up", name: "feature" });
    await expect(refused).rejects.toThrow("feature tracks origin, so jj will not create feature@up until it is tracked.");
    await expect(refused).rejects.not.toThrow("configure Git credentials");
    const resolved = await f.repo.resolve(target, 1);
    if (resolved.kind !== "one") throw new Error("expected one revision");
    const preview = await f.repo.prepare({ kind: "git-publish", remote: "up", name: "feature", revision: resolved.revision });
    expect(preview.summary).toContain("Tracking: start tracking feature@up");
    await f.repo.apply(preview);
    expect(await refs(up)).toBe(`refs/heads/feature ${target}\n`);
    expect((await f.repo.bookmarks()).find(item => item.name === "feature" && item.remote === "up")?.tracked).toBe(true);
  } finally { await f.cleanup(); await rm(up, { recursive: true, force: true }); }
});

test("a push over an untracked remote bookmark of the same name is refused with the step to take", async () => {
  const f = await remoteFixture();
  try {
    await f.repo.apply(await f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
    await f.jj("bookmark", "untrack", "feature", "--remote", "origin");
    expect(pushRoute("feature", "origin", await f.repo.bookmarks())).toMatchObject({ kind: "refuse" });
    const before = await f.repo.operationId();
    // jj itself would refuse at the dry run with "Non-tracking remote bookmark feature@origin exists".
    const refused = f.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" });
    await expect(refused).rejects.toThrow("feature@origin exists and is not tracked, so jj will not push feature over it. Track feature@origin first");
    await expect(refused).rejects.not.toThrow("configure Git credentials");
    expect(await f.repo.operationId()).toBe(before);
  } finally { await f.cleanup(); }
});

test("only failures that may come from the remote get the network hint", async () => {
  for (const local of [
    "Error: Refusing to create new remote bookmark feature@up\nHint: Run `jj bookmark track feature@up` and try again.",
    "Error: Non-tracking remote bookmark feature@origin exists\nHint: Run `jj bookmark track feature@origin` to import the remote bookmark.",
    "Changes to push to nope:\n  bookmark: feature [add to 7c86ef673563]\nError: No git remote named 'nope'",
    "Warning: No matching remotes for names: nope\nError: No git remotes to fetch from",
    "Error: Won't push commit 4ec02cf8a8ff since it has no description\nHint: Rejected commit: rxlmqosw 4ec02cf8 g",
  ]) expect(remoteFailureHint(local)).toBe("");
  for (const remote of [
    "Error: Could not find repository at '/nonexistent/x.git'",
    "Error: Git process failed: External git program failed:\nfatal: unable to access 'https://nohost.invalid/x.git/': Could not resolve host: nohost.invalid",
    "Error: Failed to push some bookmarks\nHint: The following references unexpectedly moved on the remote:\n  refs/heads/feature",
    "jj timed out after 600 seconds.",
  ]) expect(remoteFailureHint(remote)).toContain("configure Git credentials or SSH");
  // A real local refusal from jj's dry run: a commit without a description.
  const f = await remoteFixture();
  try {
    await f.jj("new");
    await f.jj("bookmark", "create", "wip", "-r", "@");
    const refused = f.repo.prepare({ kind: "git-push", remote: "origin", name: "wip" });
    await expect(refused).rejects.toThrow("since it has no description");
    await expect(refused).rejects.not.toThrow("configure Git credentials");
  } finally { await f.cleanup(); }
});

test("a push that matches no bookmark fails instead of reporting it up to date", () => {
  const output = "Warning: No matching bookmarks for names: a, b\nNothing changed.\n";
  expect(() => pushCaution("a&b", "origin", output)).toThrow("jj found no bookmark named a&b to push to origin, so nothing was pushed.");
});

// Remote names jj prints quoted in `jj git remote list`, such as `"é"`, `"x@y"` and `"my|origin"`.
async function quotedRemoteFixture() {
  const f = await remoteFixture();
  const names = ["é", "x@y", "my|origin"];
  const paths: string[] = [];
  for (const name of names) {
    const path = await mkdtemp(join(tmpdir(), "jj-remote-test-"));
    const proc = Bun.spawn(["git", "init", "--bare", path], { stdout: "ignore", stderr: "pipe" });
    if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
    await f.jj("git", "remote", "add", name, path);
    paths.push(path);
  }
  return { ...f, names, paths, cleanup: async () => { await f.cleanup(); await Promise.all(paths.map(path => rm(path, { recursive: true, force: true }))); } };
}

test("remotes that jj quotes have one unquoted name for push, fetch, track, untrack and deletion", async () => {
  const f = await quotedRemoteFixture();
  try {
    expect(await f.repo.remotes()).toEqual([{ name: "origin", url: f.remote }, ...f.names.map((name, index) => ({ name, url: f.paths[index]! }))]
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    await f.jj("config", "set", "--repo", "git.push", JSON.stringify("my|origin"));
    expect((await f.repo.defaultPushRemote(await f.repo.remotes()))?.name).toBe("my|origin");
    const target = (await f.repo.bookmarks()).find(item => item.name === "feature")!.targets[0]!;
    // jj refuses to push one new bookmark to a second remote, so each remote gets its own bookmark.
    const pushed = f.names.map((_, index) => `to-${index}`);
    for (const [index, remote] of f.names.entries()) {
      const name = pushed[index]!;
      await f.jj("bookmark", "create", name, "-r", "feature");
      const preview = await f.repo.prepare({ kind: "git-push", remote, name });
      expect(preview.summary).toContain(`Remote: ${remote}\n`);
      expect(await f.repo.apply(preview)).toMatch(new RegExp(`^Pushed ${name} to ${remote.replace(/[|]/g, "\\|")}\nadded at`));
      expect(await refs(f.paths[index]!)).toBe(`refs/heads/${name} ${target}\n`);
    }
    expect(await refs(f.remote)).toBe("");
    for (const [index, remote] of f.names.entries()) {
      const name = pushed[index]!;
      await f.repo.apply(await f.repo.prepare({ kind: "bookmark-untrack", remote, name }));
      expect((await f.repo.bookmarks()).find(item => item.remote === remote && item.name === name)?.tracked).toBe(false);
      await f.repo.apply(await f.repo.prepare({ kind: "bookmark-track", remote, name }));
      expect((await f.repo.bookmarks()).find(item => item.remote === remote && item.name === name)?.tracked).toBe(true);
    }
    // A publisher adds a bookmark on `my|origin` only; fetching `my|origin` must reach it, not `origin`.
    const publisher = await fixture();
    try {
      await publisher.jj("git", "remote", "add", "my|origin", f.paths[2]!);
      await publisher.jj("bookmark", "create", "-r", "@", "--", "published");
      await publisher.jj("git", "push", "--remote", "my|origin", "--bookmark", "exact:published");
    } finally { await publisher.cleanup(); }
    expect(await f.repo.apply(await f.repo.prepare({ kind: "git-fetch", remote: "my|origin" }))).toBe("Fetched my|origin · 1 bookmark changed\npublished new");
    expect((await f.repo.bookmarks()).find(item => item.remote === "my|origin" && item.name === "published")).toBeDefined();
    const deletion = await f.repo.prepare({ kind: "bookmark-delete", name: "to-0", remote: "é", push: true });
    expect(deletion.summary).toContain("Then push the deletion to é");
    expect(await f.repo.apply(deletion)).toStartWith("Deleted to-0 here and on é");
    expect(await refs(f.paths[0]!)).toBe("");
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

// A second bare remote, with a publisher that pushes a bookmark to each remote.
async function twoRemoteFixture() {
  const f = await remoteFixture();
  const upstream = await mkdtemp(join(tmpdir(), "jj-remote-test-"));
  const proc = Bun.spawn(["git", "init", "--bare", upstream], { stdout: "ignore", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
  await f.jj("git", "remote", "add", "upstream", upstream);
  const publisher = await fixture();
  await publisher.jj("git", "remote", "add", "origin", f.remote);
  await publisher.jj("git", "remote", "add", "upstream", upstream);
  return { ...f, upstream, publisher, cleanup: async () => { await f.cleanup(); await publisher.cleanup(); await rm(upstream, { recursive: true, force: true }); } };
}

test("fetching all remotes imports new revisions and bookmarks from each one, after a read-only preview", async () => {
  const f = await twoRemoteFixture();
  try {
    await f.publisher.jj("new", "-m", "From origin");
    await f.publisher.jj("bookmark", "create", "from-origin", "-r", "@");
    await f.publisher.jj("git", "push", "--remote", "origin", "--bookmark", "exact:from-origin");
    await f.publisher.jj("new", "-m", "From upstream");
    await f.publisher.jj("bookmark", "create", "from-upstream", "-r", "@");
    await f.publisher.jj("git", "push", "--remote", "upstream", "--bookmark", "exact:from-upstream");
    const remotes = await f.repo.remotes();
    expect(remotes.map(item => item.name)).toEqual(["origin", "upstream"]);
    const before = await f.repo.operationId();
    const prepared = await f.repo.prepare({ kind: "git-fetch-all", remotes });
    expect(prepared.summary).toContain("Fetch from all 2 remotes, one at a time:");
    expect(prepared.summary).toContain(`upstream  ${f.upstream}`);
    expect(await f.repo.operationId()).toBe(before);
    expect(await f.repo.apply(prepared)).toBe("Fetched 2 remotes · 2 bookmarks changed\nfrom-origin@origin new, from-upstream@upstream new");
    const fetched = await f.repo.bookmarks();
    expect(fetched.find(item => item.name === "from-origin" && item.remote === "origin")).toBeDefined();
    expect(fetched.find(item => item.name === "from-upstream" && item.remote === "upstream")).toBeDefined();
    expect((await f.repo.snapshot("from-upstream@upstream")).revisions[0]?.description.trim()).toBe("From upstream");
    // The two fetches are consecutive operations, not siblings of the reviewed one.
    expect((await f.jj("op", "log", "--no-graph", "-T", 'parents.len() ++ "\\n"')).trim().split("\n").every(count => count === "1" || count === "0")).toBe(true);
    expect(await f.repo.apply(await f.repo.prepare({ kind: "git-fetch-all", remotes }))).toBe("Fetched 2 remotes\nalready up to date");
  } finally { await f.cleanup(); }
});

test("fetching all remotes refuses when the remotes changed after they were listed", async () => {
  const f = await twoRemoteFixture();
  try {
    const remotes = await f.repo.remotes();
    await f.jj("git", "remote", "add", "third", f.remote);
    await expect(f.repo.prepare({ kind: "git-fetch-all", remotes })).rejects.toThrow("Remote configuration changed");
    await f.jj("git", "remote", "remove", "third");
    const prepared = await f.repo.prepare({ kind: "git-fetch-all", remotes });
    await f.jj("git", "remote", "set-url", "upstream", f.remote);
    await expect(f.repo.apply(prepared)).rejects.toThrow("Remote configuration changed");
    await expect(f.repo.prepare({ kind: "git-fetch-all", remotes: [] })).rejects.toThrow("No Git remotes configured");
  } finally { await f.cleanup(); }
});

test("a failing remote stops a fetch from all remotes and says which remotes were fetched", async () => {
  const f = await twoRemoteFixture();
  try {
    await f.publisher.jj("bookmark", "create", "shared", "-r", "@-");
    await f.publisher.jj("git", "push", "--remote", "origin", "--bookmark", "exact:shared");
    await f.jj("git", "remote", "add", "broken", f.remote + "-missing");
    const remotes = await f.repo.remotes();
    expect(remotes.map(item => item.name)).toEqual(["broken", "origin", "upstream"]);
    // Order the broken remote second, so one remote is fetched before it and one after.
    const ordered = [remotes[1]!, remotes[0]!, remotes[2]!];
    const error = await f.repo.apply(await f.repo.prepare({ kind: "git-fetch-all", remotes: ordered })).then(() => null, (caught: Error) => caught);
    expect(error?.message).toContain("configure Git credentials or SSH");
    expect(error?.message).toContain("Fetched origin. Failed on broken; not fetched: upstream.");
    expect((await f.repo.bookmarks()).find(item => item.name === "shared" && item.remote === "origin")).toBeDefined();
    const first = await f.repo.apply(await f.repo.prepare({ kind: "git-fetch-all", remotes })).then(() => null, (caught: Error) => caught);
    expect(first?.message).toContain("Nothing was fetched. Failed on broken; not fetched: origin, upstream.");
  } finally { await f.cleanup(); }
});

test("cancelling a fetch from all remotes says which remotes were fetched", async () => {
  const f = await twoRemoteFixture();
  const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.ext.allow", GIT_CONFIG_VALUE_0: "always" });
  try {
    await f.jj("git", "remote", "remove", "upstream");
    await f.jj("git", "remote", "add", "slow", "ext::sleep 30");
    const remotes = await f.repo.remotes();
    const applying = f.repo.apply(await f.repo.prepare({ kind: "git-fetch-all", remotes }));
    for (let attempt = 0; attempt < 300 && !f.repo.networkActive; attempt++) await Bun.sleep(10);
    await Bun.sleep(500);
    f.repo.cancelNetwork();
    await expect(applying).rejects.toThrow("Fetch cancelled. Fetched origin. Cancelled during slow.");
    expect(f.repo.networkActive).toBe(false);
  } finally {
    for (const [key, value] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await f.cleanup();
  }
}, 40_000);

test("a fetch from all remotes names each changed bookmark with its remote", () => {
  expect(fetchAllReport([
    { remote: "origin", output: "bookmark: main@origin [updated] tracked\n" },
    { remote: "upstream", output: "Nothing changed.\n" },
    { remote: "fork", output: 'bookmark: main@fork [new] untracked\nbookmark: "ü"@fork [new] untracked\nbookmark: x@fork [deleted] untracked\n' },
  ])).toBe("Fetched 3 remotes · 4 bookmarks changed\nmain@origin updated, main@fork new, ü@fork new, +1 more");
});
