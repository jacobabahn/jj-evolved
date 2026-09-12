import type { Revision, Snapshot, GraphRow } from "./model";
import { run } from "./jj-process";
import { terminalText } from "../terminal-text";

const REVISION_TEMPLATE = `'{'
  ++ '"commitId":' ++ json(commit_id)
  ++ ',"changeId":' ++ json(change_id)
  ++ ',"changePrefix":' ++ json(change_id.shortest().prefix())
  ++ ',"description":' ++ json(description)
  ++ ',"author":' ++ json(author.name())
  ++ ',"bookmarks":' ++ json(stringify(bookmarks))
  ++ ',"parents":' ++ json(parents.map(|p| p.commit_id()))
  ++ ',"workingCopy":' ++ json(current_working_copy)
  ++ ',"conflict":' ++ json(conflict)
  ++ '}\n'`;
const LOG_TEMPLATE = REVISION_TEMPLATE + ` ++ '::jj-evolved-description::\n'`;

function parseRevision(value: unknown): Revision {
  if (
    typeof value !== "object" || value === null ||
    !("commitId" in value) || typeof value.commitId !== "string" || !/^[0-9a-f]{40,64}$/.test(value.commitId) ||
    !("changeId" in value) || typeof value.changeId !== "string" || !/^[k-z]+$/.test(value.changeId) ||
    !("changePrefix" in value) || typeof value.changePrefix !== "string" || !/^[k-z]+$/.test(value.changePrefix) || !value.changeId.startsWith(value.changePrefix) ||
    !("description" in value) || typeof value.description !== "string" ||
    !("author" in value) || typeof value.author !== "string" ||
    !("bookmarks" in value) || typeof value.bookmarks !== "string" ||
    !("parents" in value) || !Array.isArray(value.parents) ||
    !("workingCopy" in value) || typeof value.workingCopy !== "boolean" ||
    !("conflict" in value) || typeof value.conflict !== "boolean"
  ) throw new Error("Unexpected jj log output. This version was tested with jj 0.45.1.");
  const parents: string[] = [];
  for (const parent of value.parents) {
    if (typeof parent !== "string" || !/^[0-9a-f]{40,64}$/.test(parent)) {
      throw new Error("Unexpected parent commit ID in jj log output.");
    }
    parents.push(parent);
  }
  return {
    commitId: value.commitId, changeId: value.changeId, changePrefix: value.changePrefix,
    description: value.description, author: value.author,
    bookmarks: value.bookmarks, parents,
    workingCopy: value.workingCopy, conflict: value.conflict,
  };
}

export async function logSnapshot(root: string, revset: string, readOnly = false): Promise<Snapshot> {
  const output = await run(root, [...(readOnly ? ["--ignore-working-copy", "--at-op=@"] : []), "log", "--config", "ui.log-word-wrap=false", "--limit", "200", "--revisions", revset, "--template", LOG_TEMPLATE]);
  const revisions: Revision[] = [];
  const graph: GraphRow[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const recordStart = line.indexOf('{"commitId":');
    const descriptionStart = line.indexOf("::jj-evolved-description::");
    if (recordStart >= 0) {
      const value: unknown = JSON.parse(line.slice(recordStart));
      const revision = parseRevision(value);
      graph.push({ kind: "revision", revision, prefix: terminalText(line.slice(0, recordStart)) });
      revisions.push(revision);
    } else if (descriptionStart >= 0 && revisions.length) {
      const revision = revisions.at(-1);
      if (revision) graph.push({ kind: "description", revision, prefix: terminalText(line.slice(0, descriptionStart)) });
    } else {
      graph.push({ kind: "edge", text: terminalText(line) });
    }
  }
  return { root, revisions, graph };
}

export function parsePrefixes(output: string): ReadonlyMap<string, string> {
  const prefixes = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const row: unknown = JSON.parse(line);
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string") {
      throw new Error("Unexpected jj prefix record.");
    }
    prefixes.set(row[0], row[1]);
  }
  return prefixes;
}

export async function logRevisions(root: string, revset: string, operationId = "@"): Promise<Revision[]> {
  const output = await run(root, ["--ignore-working-copy", "--at-op", operationId, "log", "--no-graph", "-r", revset, "-T", REVISION_TEMPLATE]);
  return output.split("\n").filter(Boolean).map(line => parseRevision(JSON.parse(line)));
}
