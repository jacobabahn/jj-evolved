import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { read, resetHelpers, type HelperRequest } from "../../src/repository/jj-helper";
import { run } from "../../src/repository/jj-process";
import { Repository } from "../../src/repository/repository";
import { fixture } from "../fixture";

const binary = resolve(import.meta.dir, "../../native/target/release/jj-evolved-helper");
const configured = process.env.JJ_EVOLVED_HELPER;
const noCli = async (): Promise<string> => { throw new Error("The helper fell back to the CLI."); };

beforeEach(() => { resetHelpers(); process.env.JJ_EVOLVED_HELPER = binary; });
afterEach(() => {
  resetHelpers();
  if (configured === undefined) delete process.env.JJ_EVOLVED_HELPER; else process.env.JJ_EVOLVED_HELPER = configured;
});

/** Linear history, a merge, a conflict, and paths and contents that need care. */
async function history() {
  const f = await fixture();
  await writeFile(join(f.path, "a b*.txt"), "spaces and a glob\n");
  await writeFile(join(f.path, "ünï.txt"), "naïve ✓\n");
  await writeFile(join(f.path, "latin1.txt"), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  await f.jj("describe", "-m", "Next change\n\nWith a body");
  await f.jj("bookmark", "create", "ünï-mark");
  await f.jj("new", "-m", "Left", "feature");
  await writeFile(join(f.path, "hello.txt"), "left\n");
  await f.jj("new", "-m", "Right", "feature");
  await writeFile(join(f.path, "hello.txt"), "right\n");
  await f.jj("new", "-m", "Conflicted merge", "description(substring:Left)", "description(substring:Right)");
  await f.jj("new", "-m", "Tip");
  return f;
}

test.skipIf(!existsSync(binary))("every request kind is byte-identical to the CLI it mirrors", async () => {
  const f = await history();
  try {
    const cli = (...args: string[]) => run(f.path, args);
    const template = 'commit_id ++ " " ++ change_id.shortest() ++ " " ++ description.first_line() ++ "\\n"';
    const commits = (await cli("--ignore-working-copy", "log", "--no-graph", "-r", "all() ~ root()", "-T", 'commit_id ++ "\\n"')).trim().split("\n");
    const operation = (await cli("--ignore-working-copy", "--at-op=@", "op", "log", "--no-graph", "--limit", "1", "-T", "id"));
    const logArgs = (op: string, graph: boolean, limit: number | undefined, revset: string, text: string) => ["--ignore-working-copy", `--at-op=${op}`, "log", "--config", "ui.log-word-wrap=false", ...(graph ? [] : ["--no-graph"]), ...(limit ? ["--limit", String(limit)] : []), "-r", revset, "-T", text];
    const pairs: [HelperRequest, string[]][] = [[{ kind: "opId" }, ["--ignore-working-copy", "--at-op=@", "op", "log", "--no-graph", "--limit", "1", "-T", "id"]]];
    for (const revset of ["all()", "@", "none()", "::feature", "conflicts()", "bookmarks()"]) {
      for (const graph of [true, false]) {
        pairs.push([{ kind: "log", revset, template, limit: 3, graph }, logArgs("@", graph, 3, revset, template)]);
        pairs.push([{ kind: "log", revset, template, graph }, logArgs("@", graph, undefined, revset, template)]);
      }
      pairs.push([{ kind: "log", revset, template: '"x"', limit: 4, graph: false, op: operation }, logArgs(operation, false, 4, revset, '"x"')]);
    }
    const filesTemplate = '"[" ++ json(path) ++ "," ++ json(status) ++ "]\\n"';
    for (const commitId of commits) {
      pairs.push([{ kind: "diff", commitId, paths: [] }, ["--ignore-working-copy", "--at-op=@", "diff", "--revision", commitId, "--git", "--"]]);
      pairs.push([{ kind: "diff", commitId, paths: ['root-file:"a b*.txt"', 'root-file:"ünï.txt"'] }, ["--ignore-working-copy", "--at-op=@", "diff", "--revision", commitId, "--git", "--", 'root-file:"a b*.txt"', 'root-file:"ünï.txt"']]);
      pairs.push([{ kind: "files", commitId, template: filesTemplate }, ["--ignore-working-copy", "diff", "-r", commitId, "-T", filesTemplate]]);
    }
    const bookmarksTemplate = 'name ++ " " ++ if(remote, stringify(remote), "") ++ " " ++ tracked ++ "\\n"';
    pairs.push([{ kind: "bookmarks", template: bookmarksTemplate }, ["--ignore-working-copy", "--at-op=@", "bookmark", "list", "--all-remotes", "-T", bookmarksTemplate]]);
    for (const [request, args] of pairs) expect({ request, text: await read(f.path, request, noCli) }).toEqual({ request, text: await cli(...args) });
  } finally { await f.cleanup(); }
});

test.skipIf(!existsSync(binary))("Repository reads agree with and without the helper, and follow external changes", async () => {
  const f = await history();
  const snapshotAll = async (repo: Repository) => {
    const snapshot = await repo.snapshot("all()", true, 3);
    const revisions = await repo.navigationRevisions("all()");
    return {
      snapshot, revisions, operation: await repo.operationId(), bookmarks: await repo.bookmarks(),
      diffs: await Promise.all(revisions.slice(0, -1).map(revision => repo.diff(revision))),
      files: await Promise.all(revisions.slice(0, -1).map(revision => repo.files(revision))),
    };
  };
  try {
    const repo = await Repository.open(f.path);
    const compare = async () => {
      repo.clearDiffs();
      process.env.JJ_EVOLVED_HELPER = binary;
      const helper = await snapshotAll(repo);
      repo.clearDiffs();
      process.env.JJ_EVOLVED_HELPER = "off";
      expect(helper).toEqual(await snapshotAll(repo));
      process.env.JJ_EVOLVED_HELPER = binary;
      return helper;
    };
    const before = await compare();
    await f.jj("describe", "-m", "Changed from another process");
    const after = await compare();
    expect(after.operation).not.toBe(before.operation);
    expect(after.snapshot.revisions[0]?.description).toBe("Changed from another process\n");
    // The helper never snapshots, so an edit stays invisible until the CLI records it.
    await writeFile(join(f.path, "unsnapshotted.txt"), "new\n");
    expect(await repo.operationId()).toBe(after.operation);
    await repo.snapshotOperationId();
    expect(await repo.operationId()).not.toBe(after.operation);
    await compare();
  } finally { await f.cleanup(); }
});

test.skipIf(!existsSync(binary))("what the helper refuses reaches the CLI: bad revsets and old operations", async () => {
  const f = await history();
  try {
    const old = (await f.jj("op", "log", "--no-graph", "-T", 'id ++ "\\n"')).trim().split("\n")[3]!;
    let fallbacks = 0;
    const fallback = async () => { ++fallbacks; return "cli"; };
    const request = (revset: string, op?: string): HelperRequest => ({ kind: "log", revset, template: "commit_id", graph: false, limit: 1, ...(op ? { op } : {}) });
    expect(await read(f.path, request("invalid((("), fallback)).toBe("cli");
    expect(await read(f.path, request("@", old), fallback)).toBe("cli");
    expect(fallbacks).toBe(2);
    expect(await read(f.path, request("@"), noCli)).toMatch(/^[0-9a-f]{40}$/);
    const repo = await Repository.open(f.path);
    await expect(repo.snapshot("invalid(((", true)).rejects.toThrow("Syntax error");
  } finally { await f.cleanup(); }
});
