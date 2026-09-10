import { expect, test } from "bun:test";
import { MutationReview } from "../../src/history/mutation-review";
import type { Mutation, PreparedMutation } from "../../src/repository/model";
import { Repository } from "../../src/repository/repository";
import { fixture } from "../fixture";

const first: Mutation = { kind: "bookmark-delete", name: "first" };
const second: Mutation = { kind: "bookmark-delete", name: "second" };
function prepared(action: Mutation): PreparedMutation {
  return { action, operationId: "operation", summary: action.kind, trees: null };
}

test("a replacement preview invalidates approval and ignores late preparation", async () => {
  const old = Promise.withResolvers<PreparedMutation>();
  const latest = Promise.withResolvers<PreparedMutation>();
  const applied: Mutation[] = [];
  const review = new MutationReview({
    prepare: action => action === first ? old.promise : latest.promise,
    apply: async result => { applied.push(result.action); },
  }, async () => {});
  const oldRequest = review.prepare(first);
  const latestRequest = review.prepare(second);
  expect(await review.apply()).toEqual({ kind: "not-ready" });
  latest.resolve(prepared(second));
  await latestRequest;
  old.resolve(prepared(first));
  expect(await oldRequest).toBeNull();
  expect(await review.apply()).toEqual({ kind: "applied", action: second, refreshError: null });
  expect(applied).toEqual([second]);
  expect(await review.apply()).toEqual({ kind: "not-ready" });
});

for (const end of ["cancel", "dispose"] as const) {
  test(`${end} prevents a late preparation error from reopening review`, async () => {
    const gate = Promise.withResolvers<PreparedMutation>();
    const review = new MutationReview({ prepare: () => gate.promise, apply: async () => { throw new Error("Unexpected write"); } }, async () => {});
    const pending = review.prepare(first);
    review[end]();
    gate.reject(new Error("Old preparation failed"));
    expect(await pending).toBeNull();
    expect(review.ready).toBe(false);
    expect(await review.apply()).toEqual({ kind: "not-ready" });
  });
}

test("applying excludes another write and replacement preview through refresh", async () => {
  const write = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<void>();
  const refreshing = Promise.withResolvers<void>();
  let writes = 0;
  const review = new MutationReview({
    prepare: async action => prepared(action),
    apply: async () => { ++writes; await write.promise; },
  }, async () => { refreshing.resolve(); await refresh.promise; });
  await review.prepare(first);
  const applying = review.apply();
  expect(await review.apply()).toEqual({ kind: "not-ready" });
  expect(await review.prepare(second)).toBeNull();
  review.cancel();
  expect(review.applying).toBe(true);
  write.resolve();
  await refreshing.promise;
  expect(review.applying).toBe(true);
  expect(await review.apply()).toEqual({ kind: "not-ready" });
  refresh.resolve();
  expect((await applying).kind).toBe("applied");
  expect(writes).toBe(1);
});

test("a failed preparation cannot leave an earlier preview approved", async () => {
  const review = new MutationReview({
    prepare: async action => { if (action === second) throw new Error("Invalid destination"); return prepared(action); },
    apply: async () => { throw new Error("Unexpected write"); },
  }, async () => {});
  await review.prepare(first);
  await expect(review.prepare(second)).rejects.toThrow("Invalid destination");
  expect(await review.apply()).toEqual({ kind: "not-ready" });
});

test("stale repository state requires a fresh review before a real bookmark write", async () => {
  const f = await fixture();
  try {
    const repo = await Repository.open(f.path);
    const review = new MutationReview(repo, async () => {});
    const action: Mutation = { kind: "bookmark-rename", name: "feature", newName: "reviewed" };
    await review.prepare(action);
    await f.jj("bookmark", "create", "external");
    await expect(review.apply()).rejects.toThrow("Repository changed since this preview");
    expect(await review.apply()).toEqual({ kind: "not-ready" });
    expect((await repo.bookmarks()).some(bookmark => bookmark.name === "feature")).toBe(true);
    await review.prepare(action);
    expect((await review.apply()).kind).toBe("applied");
    expect((await repo.bookmarks()).some(bookmark => bookmark.name === "reviewed")).toBe(true);
  } finally { await f.cleanup(); }
}, 15_000);

test("a failed refresh preserves write success and cannot repeat the operation", async () => {
  const f = await fixture();
  try {
    const repo = await Repository.open(f.path);
    const review = new MutationReview(repo, async () => { throw new Error("Cannot reload graph"); });
    const action: Mutation = { kind: "bookmark-rename", name: "feature", newName: "completed" };
    await review.prepare(action);
    const result = await review.apply();
    expect(result).toEqual({ kind: "applied", action, refreshError: "Operation succeeded, but refresh failed. Press r; do not repeat the action. Cannot reload graph" });
    expect((await repo.bookmarks()).some(bookmark => bookmark.name === "completed")).toBe(true);
    const operation = await repo.operationId();
    expect(await review.apply()).toEqual({ kind: "not-ready" });
    expect(await repo.operationId()).toBe(operation);
  } finally { await f.cleanup(); }
}, 15_000);

test("disposing during a write suppresses later refresh without claiming the write was cancelled", async () => {
  const gate = Promise.withResolvers<void>();
  let refreshed = false;
  const review = new MutationReview({ prepare: async action => prepared(action), apply: () => gate.promise }, async () => { refreshed = true; });
  await review.prepare(first);
  const applying = review.apply();
  review.dispose();
  gate.resolve();
  expect(await applying).toEqual({ kind: "disposed" });
  expect(refreshed).toBe(false);
  expect(await review.prepare(second)).toBeNull();
});
