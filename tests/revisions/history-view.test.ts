import { expect, test } from "bun:test";
import { Repository } from "../../src/repository/repository";
import { contextView, loadHistory, type NavigationView } from "../../src/revisions/history-view";
import { fixture } from "../fixture";

// The fixture's history, newest first: "Next change" (@), "Initial feature" (bookmark feature), root.
async function setup() {
  const f = await fixture();
  const repository = await Repository.open(f.path);
  const first = await loadHistory(repository, { revset: "all()", limit: 200, previous: () => null });
  const selecting = (description: string, from = first.view): NavigationView =>
    ({ ...from, index: from.snapshot.revisions.findIndex(item => item.description.trim() === description), top: 3 });
  return { f, repository, first, selecting };
}

test("a reload keeps the selection on a rewritten revision and carries the scroll position", async () => {
  const { f, repository, selecting } = await setup();
  try {
    await f.jj("describe", "-r", "feature", "-m", "Renamed feature");
    const { view, returnPoint, search } = await loadHistory(repository, { revset: "all()", limit: 200, previous: () => selecting("Initial feature") });
    expect(view.snapshot.revisions[view.index]?.description.trim()).toBe("Renamed feature");
    expect(view.top).toBe(3);
    expect(returnPoint).toBeNull();
    // Without a query the caller's search is left alone.
    expect(search).toBeUndefined();
  } finally { await f.cleanup(); }
});

test("a vanished selection returns to the top, or keeps its row when asked; the working copy can be selected instead", async () => {
  const { f, repository, selecting } = await setup();
  try {
    await f.jj("abandon", "feature");
    const previous = () => selecting("Initial feature");
    expect((await loadHistory(repository, { revset: "all()", limit: 200, previous })).view.index).toBe(0);
    const kept = await loadHistory(repository, { revset: "all()", limit: 200, previous, keepPosition: true });
    expect(kept.view.index).toBe(1);
    const workingCopy = await loadHistory(repository, { revset: "all()", limit: 200, previous, selectWorkingCopy: true });
    expect(workingCopy.view.snapshot.revisions[workingCopy.view.index]?.workingCopy).toBe(true);
  } finally { await f.cleanup(); }
});

test("a reload re-runs the search over the whole revset, including bookmark names", async () => {
  const { f, repository } = await setup();
  try {
    const { search } = await loadHistory(repository, { revset: "all()", limit: 1, previous: () => null, query: "feature" });
    expect(search?.matches.map(item => item.description.trim())).toEqual(["Initial feature"]);
    expect((await loadHistory(repository, { revset: "all()", limit: 200, previous: () => null, query: "" })).search).toEqual({ query: "", matches: [] });
  } finally { await f.cleanup(); }
});

test("a context view outside the revset is rebuilt around the rewritten revision", async () => {
  const { f, repository } = await setup();
  try {
    const revsetView = (await loadHistory(repository, { revset: "@", limit: 200, previous: () => null })).view;
    const [feature] = await repository.navigationRevisions("feature");
    const context = await contextView(repository, feature!, "@", revsetView.bookmarks);
    const browsing: NavigationView = { ...context, index: context.snapshot.revisions.findIndex(item => item.commitId === feature!.commitId), top: 0 };
    expect(browsing.outside.has(feature!.commitId)).toBe(true);
    await f.jj("describe", "-r", "feature", "-m", "Renamed feature");
    const loaded = await loadHistory(repository, {
      revset: "@", limit: 200, previous: () => browsing, context: { returnPoint: revsetView, revision: feature! },
    });
    const selected = loaded.view.snapshot.revisions[loaded.view.index]!;
    expect(selected.description.trim()).toBe("Renamed feature");
    expect(loaded.view.outside.has(selected.commitId)).toBe(true);
    expect(loaded.returnPoint?.snapshot.revisions.map(item => item.workingCopy)).toEqual([true]);
  } finally { await f.cleanup(); }
});
