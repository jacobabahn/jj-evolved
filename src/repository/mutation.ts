import type { Mutation } from "./model";

export function literalPath(path: string): string { return `root-file:${JSON.stringify(path)}`; }

export function mutationArgs(action: Mutation): string[] {
  let args: string[];
  switch (action.kind) {
    case "describe": args = ["describe", action.revision.commitId, "--message", action.description]; break;
    case "new": args = ["new", action.parent.commitId]; break;
    case "edit": args = ["edit", action.revision.commitId]; break;
    case "abandon": args = ["abandon", action.revision.commitId]; break;
    case "rebase":
    case "squash": args = action.kind === "rebase"
      ? ["rebase", action.descendants ? "--source" : "--revisions", action.revision.commitId, "--onto", action.destination.commitId]
      : ["squash", "--from", action.revision.commitId, "--into", action.destination.commitId, "--message", action.description, "--", ...action.files.map(literalPath)]; break;
    case "split": args = ["split", "--revision", action.revision.commitId, "--message", action.description, "--", ...action.files.map(literalPath)]; break;
    case "bookmark-create": args = ["bookmark", "create", "--revision", action.revision.commitId, "--", action.name]; break;
    case "bookmark-move": args = ["bookmark", "set", "--allow-backwards", "--revision", action.revision.commitId, "--", action.name]; break;
    case "bookmark-delete": args = ["bookmark", "delete", "--", `exact:${action.name}`]; break;
    case "bookmark-rename": args = ["bookmark", "rename", "--", action.name, action.newName]; break;
    case "undo": args = ["op", "revert", action.operation.id, "--what", "repo"]; break;
    case "restore": args = ["op", "restore", action.operation.id, "--what", "repo"]; break;
    default: { const exhaustive: never = action; throw new Error(`Unknown action ${exhaustive}`); }
  }
  return args;
}
