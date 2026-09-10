import type { Mutation, TreeComparison } from "./model";
import { run } from "./jj-process";
import { mutationArgs } from "./mutation";
import { parsePrefixes } from "./log-snapshot";
import { terminalText } from "../terminal-text";

export async function projectedTree(root: string, action: Extract<Mutation, { kind: "rebase" | "squash" }>, operationId: string): Promise<TreeComparison> {
  const originalContext = await run(root, ["--at-op", operationId, "log", "--no-graph", "--limit", "200",
    "-r", `${action.revision.commitId}:: | ${action.destination.commitId}:: | parents(${action.revision.commitId})`, "-T", 'change_id ++ "\n"']);
  const changes = originalContext.trim().split("\n");
  if (changes.some(change => !/^[k-z]+$/.test(change))) throw new Error("Unexpected change ID in preview context.");
  const output = await run(root, ["--at-op", operationId, "--no-integrate-operation", ...mutationArgs(action)], true);
  const projectedOperation = output.match(/Operation left uncommitted because --no-integrate-operation was requested: ([0-9a-f]+)/)?.[1];
  if (!projectedOperation && !output.includes("Nothing changed.")) {
    throw new Error("jj did not return a preview operation ID. Cannot render the resulting tree.");
  }
  const affected = `(${changes.map(change => `present(${change})`).join(" | ")} | present(${action.destination.changeId})::)`;
  const args = ["log", "--config", "ui.log-word-wrap=false", "--limit", "40", "-r", `${affected} | parents(${affected})`, "-T",
    'change_id.shortest(8) ++ " " ++ local_bookmarks.map(|b| "[" ++ b.name() ++ "]").join(" ") ++ if(conflict, " [conflict]") ++ "\\n" ++ coalesce(description.first_line(), "(no description)") ++ "\\n"'];
  const prefixArgs = [...args.slice(0, -1), '"[" ++ json(change_id) ++ "," ++ json(change_id.shortest().prefix()) ++ "]" ++ "\\n"', "--no-graph"];
  const [before, after, beforeIds, afterIds] = await Promise.all([
    run(root, ["--at-op", operationId, ...args]),
    run(root, ["--at-op", projectedOperation || operationId, ...args]),
    run(root, ["--at-op", operationId, ...prefixArgs]),
    run(root, ["--at-op", projectedOperation || operationId, ...prefixArgs]),
  ]);
  return { before: terminalText(before), after: terminalText(after),
    beforePrefixes: parsePrefixes(beforeIds),
    afterPrefixes: parsePrefixes(afterIds),
  };
}
