export interface Revision {
  commitId: string;
  changeId: string;
  changePrefix: string;
  description: string;
  author: string;
  bookmarks: string;
  tags: string;
  parents: string[];
  workingCopy: boolean;
  conflict: boolean;
}

export type GraphRow =
  | { kind: "revision" | "description"; revision: Revision; prefix: string }
  | { kind: "edge"; text: string };

export interface Snapshot {
  root: string;
  revisions: Revision[];
  graph: GraphRow[];
  hasMore?: boolean;
}

/** What a typed revision or revset names, for a picker that needs exactly one revision. */
export type Resolution =
  | { kind: "one"; revision: Revision }
  // count is a lower bound when more is true.
  | { kind: "several"; count: number; more: boolean }
  | { kind: "none"; message: string };

export interface Remote { name: string; url: string }
/** Local bookmarks a publish can use without asking: those on the revision, or (advance) on its nearest bookmarked ancestors. */
export interface PublishBookmarks { names: string[]; advance: boolean }
export type RemoteMutation =
  | { kind: "git-fetch"; remote: string }
  | { kind: "git-push"; remote: string; name: string }
  | { kind: "git-publish"; remote: string; name: string; revision: Revision }
  | { kind: "bookmark-track" | "bookmark-untrack"; remote: string; name: string };

export type Mutation =
  | RemoteMutation
  // Fetches each listed remote in turn; the names and URLs are the ones the user chose from, checked again before fetching.
  | { kind: "git-fetch-all"; remotes: Remote[] }
  | { kind: "describe"; revision: Revision; description: string }
  | { kind: "new"; parent: Revision }
  | { kind: "edit" | "abandon" | "absorb"; revision: Revision }
  | { kind: "rebase"; revision: Revision; destination: Revision; descendants: boolean }
  | { kind: "squash"; revision: Revision; destination: Revision; description: string; files: string[] }
  | { kind: "split"; revision: Revision; files: string[]; description: string; secondDescription: string }
  | { kind: "bookmark-create" | "bookmark-move"; name: string; revision: Revision }
  | { kind: "bookmark-rename"; name: string; newName: string }
  // remote names a remote that tracks the bookmark; push also deletes the bookmark there.
  | { kind: "bookmark-delete"; name: string; remote?: string; push?: boolean }
  | { kind: "undo" | "restore"; operation: Operation };

/**
 * Syncing a revision's stack with trunk: the rebase `jj rebase -b <revision> -d 'trunk()'` would do, that the stack is
 * already current, that there is no trunk bookmark (which a fetch may bring), or why it cannot be rebased.
 */
export type TrunkRebase =
  | { kind: "rebase"; action: Extract<Mutation, { kind: "rebase" }> }
  | { kind: "current" | "no-trunk" | "blocked"; reason: string };

export type InteractiveAction =
  | { kind: "squash"; revision: Revision; destination: Revision }
  | { kind: "split" | "describe" | "resolve"; revision: Revision };

export interface Operation { id: string; description: string; time: string; current: boolean }
/**
 * remote is "" for a local bookmark and "git" for the synthetic bookmark of a colocated Git repository. On a tracked
 * remote bookmark, ahead and behind count the commits the local bookmark has that the remote lacks, and the reverse.
 * localOnly marks a local bookmark that is on no remote, in a repository that has remotes.
 */
export interface Bookmark { name: string; remote: string; targets: string[]; conflict: boolean; tracked?: boolean; ahead?: number; behind?: number; localOnly?: boolean }
export interface RevsetAlias { name: string; definition: string }
export function isRealRemote(bookmark: Bookmark): boolean { return bookmark.remote !== "" && bookmark.remote !== "git"; }
/** True when two bookmarks of one name point at the same commit, which is what "in sync" means for a local and a remote. */
export function sameTarget(a: Bookmark, b: Bookmark): boolean {
  return !a.conflict && !b.conflict && a.targets.length === 1 && a.targets[0] === b.targets[0] && b.targets.length === 1;
}
/**
 * How a push of one bookmark to one remote can go, decided before jj's dry run so jj never refuses it there:
 * - push: `jj git push --bookmark` as it is, which also covers a deletion and a conflict that prepare refuses.
 * - publish: jj would refuse to create the remote bookmark because the local one already tracks another remote, so the
 *   push goes through a publish, which tracks it first.
 * - refuse: an untracked remote bookmark of the same name exists, which jj will not overwrite; it must be tracked first.
 */
export type PushRoute = { kind: "push" } | { kind: "publish"; commitId: string; tracking: string[] } | { kind: "refuse"; reason: string };
export function pushRoute(name: string, remote: string, bookmarks: Bookmark[]): PushRoute {
  const local = bookmarks.find(item => !item.remote && item.name === name);
  const there = bookmarks.find(item => item.remote === remote && item.name === name);
  if (!local?.targets.length || local.conflict || there?.conflict) return { kind: "push" };
  if (there && !there.tracked) return { kind: "refuse", reason: `${name}@${remote} exists and is not tracked, so jj will not push ${name} over it. Track ${name}@${remote} first from the bookmark browser, then push.` };
  const tracking = bookmarks.filter(item => item.name === name && isRealRemote(item) && item.remote !== remote && item.tracked).map(item => item.remote);
  if (!there && tracking.length && local.targets.length === 1) return { kind: "publish", commitId: local.targets[0]!, tracking };
  return { kind: "push" };
}
export interface ChangedFile { path: string; status: string }
/** `newConflicts` counts the changes in the trees' scope that are conflicted after the operation and were not before. */
export interface TreeComparison { before: string; after: string; beforePrefixes: ReadonlyMap<string, string>; afterPrefixes: ReadonlyMap<string, string>; newConflicts?: number }
/** `caution` is set when an action that normally applies at once must stop for review, such as a push that deletes a remote bookmark. */
export interface PreparedMutation { action: Mutation; operationId: string; summary: string; trees: TreeComparison | null; remoteUrl?: string; caution?: string }

export function shortChangeId(revision: Pick<Revision, "changeId" | "changePrefix">): string {
  return revision.changeId.slice(0, Math.max(8, revision.changePrefix.length));
}

export interface EvolutionEntry { commitId: string; description: string; operationDescription: string; time: string }
export interface EvolutionPage { operationId: string; entries: EvolutionEntry[]; hasMore: boolean }

export function label(revision: Revision): string {
  return `${shortChangeId(revision)} / ${revision.commitId.slice(0, 12)} ${revision.description.trim() || "(no description)"}`;
}

export function rebaseScopeSummary(revisions: Revision[]): string {
  return `● Will rebase ${revisions.length} changes, including the source:\n${revisions.map(revision => "● " + label(revision)).join("\n")}`;
}
