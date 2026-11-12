import type { Mutation } from "./model";

export function literalPath(path: string): string { return `root-file:${JSON.stringify(path)}`; }

// Bookmark and remote arguments are parsed as jj string expressions, where `|`, `&`, `@`, `(`, `,` and `'` are syntax,
// so every name is written as a string literal. A bare-name argument takes the literal, a pattern argument `exact:` it.
export function literalName(name: string): string { return JSON.stringify(name); }
export function exactName(name: string): string { return `exact:${literalName(name)}`; }

/**
 * A new bookmark name as a jj argument. Quoted, jj accepts any name, but Git cannot store one that breaks its ref-name
 * rules (git check-ref-format --branch), so the bookmark could never be exported or pushed; such a name is refused.
 */
export function newBookmarkName(name: string): string {
  const reason = !name ? "it is empty"
    : /[\x00-\x20\x7f~^:?*[\\]/.test(name) ? "it contains a space, a control character, or one of ~ ^ : ? * [ \\"
    : name.includes("..") || name.includes("@{") || name === "@" ? "it contains .. or @{, or is @"
    : name.startsWith("-") ? "it starts with -"
    : name.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock")) || name.endsWith(".")
      ? "a part between slashes is empty, starts with a dot or ends with .lock, or the name ends with a dot"
    : "";
  if (reason) throw new Error(`Git cannot use the bookmark name ${JSON.stringify(name)}: ${reason}.`);
  return literalName(name);
}

export function mutationArgs(action: Mutation): string[] {
  let args: string[];
  switch (action.kind) {
    case "git-fetch": args = ["git", "fetch", "--remote", exactName(action.remote)]; break;
    // One `jj git fetch` per remote, so a failure or cancel can say which remotes were fetched; see applyFetchAll.
    case "git-fetch-all": throw new Error("A fetch from every remote is not a single jj command.");
    case "git-publish":
    // Push's --remote takes a plain remote name, not a pattern, so it needs no quoting.
    case "git-push": args = ["git", "push", "--remote", action.remote, "--bookmark", exactName(action.name)]; break;
    case "bookmark-track":
    case "bookmark-untrack": args = ["bookmark", action.kind === "bookmark-track" ? "track" : "untrack", "--remote", exactName(action.remote), "--", exactName(action.name)]; break;
    case "describe": args = ["describe", action.revision.commitId, "--message", action.description]; break;
    case "new": args = ["new", action.parent.commitId]; break;
    case "edit": args = ["edit", action.revision.commitId]; break;
    case "absorb": args = ["absorb", "--from", action.revision.commitId]; break;
    case "abandon": args = ["abandon", action.revision.commitId]; break;
    case "rebase":
    case "squash": args = action.kind === "rebase"
      ? ["rebase", action.descendants ? "--source" : "--revisions", action.revision.commitId, "--onto", action.destination.commitId]
      : ["squash", "--from", action.revision.commitId, "--into", action.destination.commitId, "--message", action.description, "--", ...action.files.map(literalPath)]; break;
    case "split": args = ["split", "--revision", action.revision.commitId, "--message", action.description, "--", ...action.files.map(literalPath)]; break;
    case "bookmark-create": args = ["bookmark", "create", "--revision", action.revision.commitId, "--", newBookmarkName(action.name)]; break;
    case "bookmark-move": args = ["bookmark", "set", "--allow-backwards", "--revision", action.revision.commitId, "--", newBookmarkName(action.name)]; break;
    case "bookmark-delete": args = ["bookmark", "delete", "--", exactName(action.name)]; break;
    case "bookmark-rename": args = ["bookmark", "rename", "--", literalName(action.name), newBookmarkName(action.newName)]; break;
    case "undo": args = ["op", "revert", action.operation.id, "--what", "repo"]; break;
    case "restore": args = ["op", "restore", action.operation.id, "--what", "repo"]; break;
    default: { const exhaustive: never = action; throw new Error(`Unknown action ${exhaustive}`); }
  }
  return args;
}
