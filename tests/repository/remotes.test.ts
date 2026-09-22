import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../src/repository/repository";
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
    await expect(f.repo.apply(preview)).rejects.toThrow("fetch and review again");
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
