import { label, shortChangeId, type Mutation } from "./model";
import { run } from "./jj-process";
import { logRevisions } from "./log-snapshot";
import { literalPath, mutationArgs } from "./mutation";
import { projectOperation } from "./projected-operation";

const descendantLimit = 200;

/**
 * The review of restoring files: the source, the destination change, each path it overwrites, and the diff it makes to
 * the destination, read from the restore projected at `operationId` without changing the repository or the working copy.
 * The old path of each renamed file, in `action.renameSources`, is listed and restored with it.
 */
export async function projectedRestore(root: string, action: Extract<Mutation, { kind: "restore-files" }>, operationId: string): Promise<string> {
  const { revision, from } = action;
  const files = [...action.files, ...action.renameSources ?? []];
  const paths = files.map(literalPath);
  const [parents, descendants, projected] = await Promise.all([
    from ? Promise.resolve([]) : logRevisions(root, `parents(${revision.commitId})`, operationId),
    logRevisions(root, `${revision.commitId}+::`, operationId, descendantLimit + 1),
    projectOperation(root, operationId, mutationArgs(action)),
  ]);
  const source = from ? label(from)
    : parents.length === 1 ? `its parent ${label(parents[0]!)}`
    : `the merge of its parents\n${parents.map(parent => `  ${label(parent)}`).join("\n")}`;
  const unchanged = projected.operationId === operationId;
  // The destination keeps its change ID, so at the projected operation it names the restored commit.
  const compare = (format: string[]) => run(root, ["--ignore-working-copy", "--at-op", projected.operationId, "diff",
    "--from", revision.commitId, "--to", revision.changeId, ...format, "--", ...paths]);
  const [changed, diff] = unchanged ? ["", ""] : await Promise.all([
    // A rename lists both its paths.
    compare(["-T", 'json(path) ++ "\\n" ++ json(source.path()) ++ "\\n"']),
    compare(["--git"]),
  ]);
  const touched = new Set(changed.split("\n").filter(Boolean).map(line => JSON.parse(line) as string));
  const count = files.length === 1 ? "this path" : `these ${files.length} paths`;
  const listed = files.map(path => `  ${path}${touched.has(path) ? "" : "  (already matches the source)"}`).join("\n");
  const shown = descendants.slice(0, descendantLimit);
  const rebased = unchanged || !descendants.length ? "No descendants are rebased."
    : `Descendants of ${shortChangeId(revision)} are rebased onto the result (${descendants.length > descendantLimit ? `more than ${descendantLimit}` : descendants.length}):\n${shown.map(item => "↳ " + label(item)).join("\n")}`;
  return [
    `From ${source}\nInto ${label(revision)}`,
    `Overwrites ${count} in ${shortChangeId(revision)} with the source's content:\n${listed}`,
    rebased,
    projected.diagnostics,
    unchanged ? "Nothing to restore. The files already match the source." : `Changes to ${shortChangeId(revision)}:\n${diff.trim()}`,
  ].filter(Boolean).join("\n\n");
}
