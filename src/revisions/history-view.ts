import type { Repository } from "../repository/repository";
import type { Bookmark, Revision, Snapshot } from "../repository/model";
import { matchingRevisions } from "../ui/revision-search";

export type Search = { query: string; matches: Revision[] };
export type NavigationView = { snapshot: Snapshot; bookmarks: Bookmark[]; index: number; top: number; outside: ReadonlySet<string> };

export type HistoryRequest = {
  revset: string;
  limit: number;
  /** The view whose selection and scroll position carry over, taken after the reads since browsing continues meanwhile. */
  previous: () => NavigationView | null;
  /** Select the working copy instead of recovering the previous selection. */
  selectWorkingCopy?: boolean;
  /** When the selected revision is gone, stay at the same row instead of returning to the top. */
  keepPosition?: boolean;
  /** Re-run this search against the new revisions; omitted to leave the current search alone. */
  query?: string;
  /** Reuse bookmarks already read instead of reading them again. */
  bookmarks?: Bookmark[];
  /**
   * The user is browsing a context view outside the revset: rebuild the revset view from the return point, and the
   * context view (from `previous`) around this revision's latest commit.
   */
  context?: { returnPoint: NavigationView; revision: Revision } | null;
};
export type LoadedHistory = {
  view: NavigationView;
  /** The revset view to return to, when the context view could be rebuilt. */
  returnPoint: NavigationView | null;
  search?: Search;
};

/** Reads a page of history and rebuilds the view around the user's previous place in it. */
export async function loadHistory(repository: Repository, request: HistoryRequest): Promise<LoadedHistory> {
  const { revset, limit, query } = request;
  const [snapshot, bookmarks, candidates] = await Promise.all([
    repository.snapshot(revset, true, limit),
    request.bookmarks ?? repository.bookmarks(),
    query ? repository.navigationRevisions(revset) : [],
  ]);
  const previous = request.previous();
  const base = carryOver(snapshot, bookmarks, request.context?.returnPoint ?? previous, request);
  const search = query === undefined ? undefined : { query, matches: query ? matchingRevisions(candidates, bookmarks, query) : [] };
  const revision = request.context?.revision;
  if (!revision || !previous) return { view: base, returnPoint: null, search };
  // The revision may have been rewritten since; follow its change to the new commit.
  const targets = await repository.navigationRevisions(`present(${revision.changeId})`);
  const target = targets.find(item => item.commitId === revision.commitId) ?? (targets.length === 1 ? targets[0] : undefined);
  if (!target) return { view: base, returnPoint: null, search };
  const context = await contextView(repository, target, revset, bookmarks);
  return { view: { ...carryOver(context.snapshot, bookmarks, previous, { keepPosition: true }), outside: context.outside }, returnPoint: base, search };
}

/** The revision and its nearby parents and children, marking those outside the revset. */
export async function contextView(repository: Repository, target: Revision, revset: string, bookmarks: Bookmark[] | Promise<Bookmark[]>) {
  const context = contextRevset(target);
  const [snapshot, included, resolved] = await Promise.all([
    repository.snapshot(context, true), repository.navigationRevisions(`(${context}) & (${revset})`), bookmarks,
  ]);
  const ids = new Set(included.map(item => item.commitId));
  return { snapshot, bookmarks: resolved, outside: new Set(snapshot.revisions.filter(item => !ids.has(item.commitId)).map(item => item.commitId)) };
}

/** Everything a search can match: the whole revset, not just the loaded page. */
export async function searchScope(repository: Repository, revset: string) {
  const [candidates, bookmarks] = await Promise.all([repository.navigationRevisions(revset), repository.bookmarks()]);
  return { candidates, bookmarks };
}

function carryOver(snapshot: Snapshot, bookmarks: Bookmark[], previous: NavigationView | null, options: Pick<HistoryRequest, "selectWorkingCopy" | "keepPosition">): NavigationView {
  const { revisions } = snapshot;
  let index = options.selectWorkingCopy ? revisions.findIndex(item => item.workingCopy) : -1;
  if (index < 0 && previous) index = recoveredIndex(revisions, previous.snapshot.revisions[previous.index]);
  if (index < 0) index = options.keepPosition && previous ? Math.min(previous.index, revisions.length - 1) : 0;
  return { snapshot, bookmarks, index: Math.max(0, index), top: previous?.top ?? 0, outside: new Set() };
}

/** Finds the previously selected revision by commit, or by change ID when that is still unambiguous. */
function recoveredIndex(revisions: Revision[], previous: Revision | undefined): number {
  if (!previous) return -1;
  const index = revisions.findIndex(item => item.commitId === previous.commitId);
  if (index >= 0) return index;
  const matches = revisions.filter(item => item.changeId === previous.changeId);
  return matches.length === 1 ? revisions.indexOf(matches[0]!) : -1;
}

/** The revision plus up to 39 nearby parents and children, shown when it is outside the active revset. */
function contextRevset(target: Revision) {
  return `${target.commitId} | latest(parents(${target.commitId}) | children(${target.commitId}), 39)`;
}
