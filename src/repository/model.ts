export interface Revision {
  commitId: string;
  changeId: string;
  changePrefix: string;
  description: string;
  author: string;
  bookmarks: string;
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

export interface Remote { name: string; url: string }
export type RemoteMutation =
  | { kind: "git-fetch"; remote: string }
  | { kind: "git-push"; remote: string; name: string }
  | { kind: "bookmark-track" | "bookmark-untrack"; remote: string; name: string };

export type Mutation =
  | RemoteMutation
  | { kind: "describe"; revision: Revision; description: string }
  | { kind: "new"; parent: Revision }
  | { kind: "edit" | "abandon" | "absorb"; revision: Revision }
  | { kind: "rebase"; revision: Revision; destination: Revision; descendants: boolean }
  | { kind: "squash"; revision: Revision; destination: Revision; description: string; files: string[] }
  | { kind: "split"; revision: Revision; files: string[]; description: string; secondDescription: string }
  | { kind: "bookmark-create" | "bookmark-move"; name: string; revision: Revision }
  | { kind: "bookmark-rename"; name: string; newName: string }
  | { kind: "bookmark-delete"; name: string }
  | { kind: "undo" | "restore"; operation: Operation };

export type InteractiveAction =
  | { kind: "squash"; revision: Revision; destination: Revision }
  | { kind: "split" | "describe" | "resolve"; revision: Revision };

export interface Operation { id: string; description: string; time: string; current: boolean }
export interface Bookmark { name: string; remote: string; targets: string[]; conflict: boolean; tracked?: boolean }
export interface ChangedFile { path: string; status: string }
export interface TreeComparison { before: string; after: string; beforePrefixes: ReadonlyMap<string, string>; afterPrefixes: ReadonlyMap<string, string> }
export interface PreparedMutation { action: Mutation; operationId: string; summary: string; trees: TreeComparison | null; remoteUrl?: string }

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
