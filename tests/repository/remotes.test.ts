import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../src/repository/repository";
import { fetchReport, pushChanges } from "../../src/repository/remotes";
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

test("publish creates a bookmark on the change, tracks it and pushes after a read-only review", async () => {
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
    expect(preview.summary).toContain(`Bookmark: feature (move from ${old})`);
    expect(preview.summary).toContain("Tracking: already tracking feature@origin");
    expect(preview.summary).toContain(`move feature@origin from ${old} to ${revision.commitId}`);
    expect(preview.summary).toContain("Commits to publish (1):");
    await f.repo.apply(preview);
    expect(await refs(f.remote)).toBe(`refs/heads/feature ${revision.commitId}\n`);
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
  expect(fetchReport("origin", "bookmark: a@origin [new] untracked\nbookmark: b@origin [new] untracked\nbookmark: c@origin [new] untracked\nbookmark: d@origin [deleted] untracked\n"))
    .toBe("Fetched origin · 4 bookmarks changed\na new, b new, c new, +1 more");
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
