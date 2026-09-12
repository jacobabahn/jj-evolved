import { label, type Revision } from "./model";
import { run } from "./jj-process";
import { projectOperation } from "./projected-operation";

export async function projectedAbsorb(root: string, revision: Revision, operationId: string): Promise<string> {
  const projected = await projectOperation(root, operationId, ["absorb", "--from", revision.commitId]);
  const [changes, sourceIds] = await Promise.all([
    projected.operationId === operationId ? Promise.resolve("Nothing to absorb. No changes will move.") :
      run(root, ["--at-op", operationId, "op", "diff", "--from", operationId, "--to", projected.operationId,
        "--no-graph", "--git", "--patch", "--show-changes-in", "all()"]),
    run(root, ["--at-op", projected.operationId, "log", "--no-graph", "-r", `present(${revision.changeId})`,
      "-T", 'commit_id ++ "\n"']),
  ]);
  const remaining = await Promise.all(sourceIds.trim().split("\n").filter(Boolean).map(async commitId => {
    if (!/^[0-9a-f]{40,64}$/.test(commitId)) throw new Error("Unexpected source commit ID in absorb preview.");
    const diff = await run(root, ["--at-op", projected.operationId, "diff", "-r", commitId, "--git"]);
    return `${commitId.slice(0, 12)}\n${diff.trim() || "Empty change. No file differences remain."}`;
  }));
  return `Absorb from ${label(revision)}\n\nMove eligible edits into mutable ancestors. Edits JJ cannot assign stay in the source.\n\n${projected.diagnostics}\n\nProjected changes:\n${changes}\n\nRemaining in source:\n${remaining.join("\n\n") || "The source becomes empty and is abandoned."}`;
}
