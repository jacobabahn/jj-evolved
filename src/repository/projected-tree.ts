import type { Revision, Mutation, TreeComparison } from "./model";
import { run } from "./jj-process";
import { mutationArgs } from "./mutation";
import { parsePrefixes } from "./log-snapshot";
import { terminalText } from "../terminal-text";
import { projectOperation } from "./projected-operation";

/** `rebasing` are marked ● in both trees, and `following`, the existing revisions an insert moves along, ↳. */
export async function projectedTree(root: string, action: Extract<Mutation, { kind: "rebase" | "squash" }>, operationId: string, rebasing: Revision[], following: Revision[] = []): Promise<TreeComparison> {
  const second = action.kind === "rebase" ? action.insertBefore : undefined;
  const originalContext = await run(root, ["--at-op", operationId, "log", "--no-graph", "--limit", "200",
    "-r", `${action.revision.commitId}:: | ${action.destination.commitId}:: | parents(${action.revision.commitId})${second ? ` | ${second.commitId}::` : ""}`, "-T", 'change_id ++ "\n"']);
  const changes = originalContext.trim().split("\n");
  if (changes.some(change => !/^[k-z]+$/.test(change))) throw new Error("Unexpected change ID in preview context.");
  const projected = await projectOperation(root, operationId, mutationArgs(action));
  const affected = `(${changes.map(change => `present(${change})`).join(" | ")} | present(${action.destination.changeId})::${second ? ` | present(${second.changeId})::` : ""})`;
  const among = (revisions: Revision[]) => `${JSON.stringify(" " + revisions.map(revision => revision.changeId).join(" ") + " ")}.contains(" " ++ change_id ++ " ")`;
  const marker = rebasing.length || following.length
    ? `if(${rebasing.length ? among(rebasing) : "false"}, "● ", if(${following.length ? among(following) : "false"}, "↳ ", "")) ++ ` : "";
  const args = ["log", "--config", "ui.log-word-wrap=false", "--limit", "40", "-r", `${affected} | parents(${affected})`, "-T",
    marker + 'change_id.shortest(8) ++ " " ++ local_bookmarks.map(|b| "[" ++ b.name() ++ if(b.conflict(), "!") ++ "]").join(" ") ++ if(conflict, " ! conflict") ++ "\\n" ++ coalesce(description.first_line(), "(no description)") ++ "\\n"'];
  const prefixArgs = [...args.slice(0, -1), '"[" ++ json(change_id) ++ "," ++ json(change_id.shortest().prefix()) ++ "]" ++ "\\n"', "--no-graph"];
  // Every change the operation can rewrite, not only the trees' first 40 rows.
  const conflictArgs = ["log", "--no-graph", "-r", `conflicts() & (${affected})`, "-T", 'change_id ++ "\n"'];
  const [before, after, beforeIds, afterIds, beforeConflicts, afterConflicts] = await Promise.all([
    run(root, ["--at-op", operationId, ...args]),
    run(root, ["--at-op", projected.operationId, ...args]),
    run(root, ["--at-op", operationId, ...prefixArgs]),
    run(root, ["--at-op", projected.operationId, ...prefixArgs]),
    run(root, ["--at-op", operationId, ...conflictArgs]),
    run(root, ["--at-op", projected.operationId, ...conflictArgs]),
  ]);
  const conflicted = new Set(beforeConflicts.split("\n").filter(Boolean));
  return { before: terminalText(before), after: terminalText(after),
    newConflicts: afterConflicts.split("\n").filter(id => id && !conflicted.has(id)).length,
    beforePrefixes: parsePrefixes(beforeIds),
    afterPrefixes: parsePrefixes(afterIds),
  };
}
