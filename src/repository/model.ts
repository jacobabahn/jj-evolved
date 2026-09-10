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
}

export type Mutation =
  | { kind: "describe"; revision: Revision; description: string }
  | { kind: "new"; parent: Revision }
  | { kind: "edit" | "abandon"; revision: Revision }
  | { kind: "rebase"; revision: Revision; destination: Revision; descendants: boolean }
  | { kind: "squash"; revision: Revision; destination: Revision; description: string; files: string[] }
  | { kind: "split"; revision: Revision; files: string[]; description: string }
  | { kind: "bookmark-create" | "bookmark-move"; name: string; revision: Revision }
  | { kind: "bookmark-rename"; name: string; newName: string }
  | { kind: "bookmark-delete"; name: string }
  | { kind: "undo" | "restore"; operation: Operation };

export type InteractiveAction =
  | { kind: "squash"; revision: Revision; destination: Revision }
  | { kind: "split"; revision: Revision };

export interface Operation { id: string; description: string; time: string; current: boolean }
export interface Bookmark { name: string; remote: string; targets: string[]; conflict: boolean }
export interface ChangedFile { path: string; status: string }
export interface TreeComparison { before: string; after: string; beforePrefixes: ReadonlyMap<string, string>; afterPrefixes: ReadonlyMap<string, string> }
export interface PreparedMutation { action: Mutation; operationId: string; summary: string; trees: TreeComparison | null }

export function shortChangeId(revision: Pick<Revision, "changeId" | "changePrefix">): string {
  return revision.changeId.slice(0, Math.max(8, revision.changePrefix.length));
}
