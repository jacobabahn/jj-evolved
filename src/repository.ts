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

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Unexpected jj template field.");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Unexpected jj template field.");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Unexpected jj template record.");
  return value;
}
function tuples(output: string): unknown[][] {
  return output.split("\n").filter(Boolean).map(line => array(JSON.parse(line)));
}
function literalPath(path: string): string { return `root-file:${JSON.stringify(path)}`; }
export function shortChangeId(revision: Pick<Revision, "changeId" | "changePrefix">): string {
  return revision.changeId.slice(0, Math.max(8, revision.changePrefix.length));
}

function label(revision: Revision): string {
  return `${shortChangeId(revision)} / ${revision.commitId.slice(0, 12)} ${revision.description.trim() || "(no description)"}`;
}


const LOG_TEMPLATE = `'{'
  ++ '"commitId":' ++ json(commit_id)
  ++ ',"changeId":' ++ json(change_id)
  ++ ',"changePrefix":' ++ json(change_id.shortest().prefix())
  ++ ',"description":' ++ json(description)
  ++ ',"author":' ++ json(author.name())
  ++ ',"bookmarks":' ++ json(stringify(bookmarks))
  ++ ',"parents":' ++ json(parents.map(|p| p.commit_id()))
  ++ ',"workingCopy":' ++ json(current_working_copy)
  ++ ',"conflict":' ++ json(conflict)
  ++ '}\n' ++ '::jj-evolved-description::\n'`;

export function terminalText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

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

async function run(path: string, args: string[], diagnostics = false): Promise<string> {
  if (!Bun.which("jj")) throw new Error("jj is not installed. Install Jujutsu, then run jj-evolved again.");
  const proc = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
    cwd: path, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, JJ_INTERACTIVE: "0" },
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(terminalText(stderr.trim()) || "jj command failed or exceeded 30 seconds.");
    return diagnostics ? stdout + stderr : stdout;
  } finally { clearTimeout(timer); }
}

type HistoryMutation = Extract<Mutation, { kind: "rebase" | "squash" }>;

function historyArgs(action: HistoryMutation): string[] {
  return action.kind === "rebase"
    ? ["rebase", action.descendants ? "--source" : "--revisions", action.revision.commitId, "--onto", action.destination.commitId]
    : ["squash", "--from", action.revision.commitId, "--into", action.destination.commitId, "--message", action.description, "--", ...action.files.map(literalPath)];
}

async function projectedTree(root: string, action: HistoryMutation, operationId: string): Promise<TreeComparison> {
  const originalContext = await run(root, ["--at-op", operationId, "log", "--no-graph", "--limit", "200",
    "-r", `${action.revision.commitId}:: | ${action.destination.commitId}:: | parents(${action.revision.commitId})`, "-T", 'change_id ++ "\n"']);
  const changes = originalContext.trim().split("\n");
  if (changes.some(change => !/^[k-z]+$/.test(change))) throw new Error("Unexpected change ID in preview context.");
  const output = await run(root, ["--at-op", operationId, "--no-integrate-operation", ...historyArgs(action)], true);
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
    beforePrefixes: new Map(tuples(beforeIds).map(row => [string(row[0]), string(row[1])])),
    afterPrefixes: new Map(tuples(afterIds).map(row => [string(row[0]), string(row[1])])),
  };
}

export class Repository {
  private constructor(readonly root: string) {}

  static async open(path: string): Promise<Repository> {
    return new Repository((await run(path, ["root"])).trim());
  }

  async snapshot(revset: string): Promise<Snapshot> {
    const output = await run(this.root, ["log", "--config", "ui.log-word-wrap=false", "--limit", "200", "--revisions", revset, "--template", LOG_TEMPLATE]);
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
    return { root: this.root, revisions, graph };
  }

  async diff(revision: Revision, files: string[] = []): Promise<string> {
    return terminalText(await run(this.root, ["--ignore-working-copy", "diff", "--revision", revision.commitId, "--git", "--", ...files.map(literalPath)]));
  }

  async status(): Promise<string> {
    return terminalText(await run(this.root, ["status"]));
  }

  async operationId(): Promise<string> {
    return (await run(this.root, ["--ignore-working-copy", "--at-op=@", "op", "log", "--no-graph", "--limit", "1", "-T", "id"])).trim();
  }

  async operations(limit = 50): Promise<Operation[]> {
    const output = await run(this.root, ["--ignore-working-copy", "--at-op=@", "op", "log", "--no-graph", "--limit", String(limit), "-T",
      `'[' ++ json(id) ++ ',' ++ json(description) ++ ',' ++ json(stringify(time)) ++ ',' ++ json(current_operation) ++ ']\n'`]);
    return tuples(output).map(([id, description, time, current]) => ({ id: string(id), description: string(description), time: string(time), current: boolean(current) }));
  }

  async operationDiff(operation: Operation): Promise<string> {
    return terminalText(await run(this.root, ["--ignore-working-copy", "--at-op=@", "op", "show", operation.id, "--no-graph", "--git", "-p"]));
  }

  async bookmarks(): Promise<Bookmark[]> {
    const output = await run(this.root, ["--ignore-working-copy", "--at-op=@", "bookmark", "list", "--all-remotes", "-T",
      `'[' ++ json(name) ++ ',' ++ json(if(remote, stringify(remote), "")) ++ ',' ++ json(added_targets.map(|c| c.commit_id())) ++ ',' ++ json(conflict) ++ ']\n'`]);
    return tuples(output).map(([name, remote, targets, conflict]) => ({ name: string(name), remote: string(remote), targets: array(targets).map(string), conflict: boolean(conflict) }));
  }

  async files(revision: Revision): Promise<ChangedFile[]> {
    const output = await run(this.root, ["--ignore-working-copy", "diff", "-r", revision.commitId, "-T",
      `'[' ++ json(path) ++ ',' ++ json(status) ++ ']\n'`]);
    return tuples(output).map(([path, status]) => ({ path: string(path), status: string(status) }));
  }

  async interactive(action: InteractiveAction): Promise<void> {
    await this.status();
    const targets = action.kind === "squash" ? [action.revision, action.destination] : [action.revision];
    for (const revision of targets) {
      if (!(await this.snapshot(`present(${revision.changeId})`)).revisions.some(current => current.commitId === revision.commitId)) {
        throw new Error("The selected revision has changed. Refresh and select it again.");
      }
    }
    const args = action.kind === "squash"
      ? ["squash", "--interactive", "--from", action.revision.commitId, "--into", action.destination.commitId]
      : ["split", "--interactive", "--revision", action.revision.commitId];
    const editorProcess = Bun.spawn(["jj", "--no-pager", ...args], {
      cwd: this.root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, JJ_INTERACTIVE: "1" },
    });
    const interrupt = () => { editorProcess.kill("SIGINT"); };
    process.on("SIGINT", interrupt);
    try {
      const code = await editorProcess.exited;
      if (code !== 0) throw new Error(`Interactive ${action.kind} did not complete (exit code ${code}).`);
    } finally { process.off("SIGINT", interrupt); }
  }

  async openHunk(revision: Revision): Promise<void> {
    const executable = Bun.which("hunk", { PATH: process.env.PATH ?? "" });
    if (!executable) throw new Error("Hunk is not installed or is not on PATH. Install it with npm install -g hunkdiff, then try again.");
    const viewer = Bun.spawn([executable, "show", revision.commitId], {
      cwd: this.root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      env: process.env,
    });
    const interrupt = () => { viewer.kill("SIGINT"); };
    process.on("SIGINT", interrupt);
    try {
      const code = await viewer.exited;
      if (code !== 0) throw new Error(`Hunk exited with code ${code}.`);
    } finally { process.off("SIGINT", interrupt); }
  }

  async prepare(action: Mutation): Promise<PreparedMutation> {
    await this.status();
    const operationId = await this.operationId();
    const targets = "revision" in action ? [action.revision] : action.kind === "new" ? [action.parent] : [];
    if ("destination" in action) targets.push(action.destination);
    for (const revision of targets) {
      const visible = await this.snapshot(`${revision.commitId} & all()`);
      if (!visible.revisions.length) throw new Error("The selected revision has changed. Refresh and select it again.");
    }
    let summary: string;
    switch (action.kind) {
      case "describe": summary = `Describe ${label(action.revision)}\n\n${action.description}`; break;
      case "new": summary = `Create an empty child of ${label(action.parent)}`; break;
      case "edit": summary = `Make this change the working copy:\n${label(action.revision)}`; break;
      case "abandon":
      case "rebase": {
        const affected = await this.snapshot(`${action.revision.commitId}::`);
        summary = `${action.kind === "abandon" ? "Abandon" : "Rebase"} ${label(action.revision)}\n`;
        if (action.kind === "rebase") summary += `Onto ${label(action.destination)}\nMode: ${action.descendants ? "selected revision and descendants" : "selected revision only; descendants fill the gap"}\n`;
        summary += `\nAffected revision/descendant context (up to 200):\n${affected.revisions.map(label).join("\n")}\n\nDescendants may be rewritten and conflicts may result.`;
        break;
      }
      case "squash":
        summary = `Squash from ${label(action.revision)}\nInto ${label(action.destination)}\nFiles: ${action.files.length ? action.files.join(", ") : "all"}\nThe source is abandoned if emptied.\nDestination description:\n${action.description}\n\n${await this.diff(action.revision, action.files)}`;
        break;
      case "split": {
        const files = await this.files(action.revision);
        if (!action.files.length || action.files.length >= files.length || action.files.some(path => !files.some(file => file.path === path))) throw new Error("Select some, but not all, changed files to split.");
        summary = `Split ${label(action.revision)}\n\nFirst change: ${action.description}\n${action.files.join("\n")}\n\nSecond change keeps the original description:\n${action.revision.description}\n${files.filter(file => !action.files.includes(file.path)).map(file => file.path).join("\n")}\n\nThe combined file contents are preserved.`;
        break;
      }
      case "bookmark-create": summary = `Create local bookmark ${action.name} at\n${label(action.revision)}`; break;
      case "bookmark-move":
      case "bookmark-delete":
      case "bookmark-rename": {
        const bookmark = (await this.bookmarks()).find(item => !item.remote && item.name === action.name);
        if (!bookmark) throw new Error("This local bookmark no longer exists. Reload bookmarks.");
        summary = `${action.kind} ${action.name}\nCurrent targets: ${bookmark.targets.join(", ") || "deleted"}`;
        if (action.kind === "bookmark-move") summary += `\nNew target: ${label(action.revision)}`;
        if (action.kind === "bookmark-rename") summary += `\nNew name: ${action.newName}`;
        if (action.kind === "bookmark-delete") summary += "\nLocal deletion only. Remote bookmarks are not pushed.";
        break;
      }
      case "undo":
        if (operationId !== action.operation.id) throw new Error("The latest operation changed. Open operation history again.");
        summary = `Undo this exact operation by applying its inverse:\n${action.operation.description}\n${action.operation.id}\n\n${await this.operationDiff(action.operation)}`;
        break;
      case "restore": summary = `Restore repository state and local bookmarks to:\n${action.operation.description}\n${action.operation.id}\n\nLater changes leave the current view but remain in operation history. Remote-tracking state is preserved.`; break;
      default: { const exhaustive: never = action; throw new Error(`Unknown action ${exhaustive}`); }
    }
    const trees = action.kind === "rebase" || action.kind === "squash"
      ? await projectedTree(this.root, action, operationId) : null;
    if (await this.operationId() !== operationId) throw new Error("Repository changed while preparing the preview. Try again.");
    return { action, operationId, summary: terminalText(summary), trees };
  }

  async apply(prepared: PreparedMutation): Promise<void> {
    await this.status();
    if (await this.operationId() !== prepared.operationId) throw new Error("Repository changed since this preview. Review the action again before applying.");
    const action = prepared.action;
    let args: string[];
    switch (action.kind) {
      case "describe": args = ["describe", action.revision.commitId, "--message", action.description]; break;
      case "new": args = ["new", action.parent.commitId]; break;
      case "edit": args = ["edit", action.revision.commitId]; break;
      case "abandon": args = ["abandon", action.revision.commitId]; break;
      case "rebase":
      case "squash": args = historyArgs(action); break;
      case "split": args = ["split", "--revision", action.revision.commitId, "--message", action.description, "--", ...action.files.map(literalPath)]; break;
      case "bookmark-create": args = ["bookmark", "create", "--revision", action.revision.commitId, "--", action.name]; break;
      case "bookmark-move": args = ["bookmark", "set", "--allow-backwards", "--revision", action.revision.commitId, "--", action.name]; break;
      case "bookmark-delete": args = ["bookmark", "delete", "--", `exact:${action.name}`]; break;
      case "bookmark-rename": args = ["bookmark", "rename", "--", action.name, action.newName]; break;
      case "undo": args = ["op", "revert", action.operation.id, "--what", "repo"]; break;
      case "restore": args = ["op", "restore", action.operation.id, "--what", "repo"]; break;
      default: { const exhaustive: never = action; throw new Error(`Unknown action ${exhaustive}`); }
    }
    await run(this.root, args);
  }
}
