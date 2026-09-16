import { label, rebaseScopeSummary, type EvolutionEntry, type EvolutionPage, type Revision, type Snapshot, type Mutation, type InteractiveAction, type Operation, type Bookmark, type ChangedFile, type PreparedMutation } from "./model";
import { run } from "./jj-process";
import { logSnapshot, logRevisions } from "./log-snapshot";
import { literalPath, mutationArgs } from "./mutation";
import { projectedAbsorb } from "./projected-absorb";
import { projectedTree } from "./projected-tree";
import { runInteractive, openHunk } from "./external-tools";
import { runSplit } from "./split";
import { terminalText } from "../terminal-text";

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
export class Repository {
  private constructor(readonly root: string) {}

  static async open(path: string): Promise<Repository> {
    return new Repository((await run(path, ["root"])).trim());
  }

  async snapshot(revset: string, readOnly = false): Promise<Snapshot> {
    return logSnapshot(this.root, revset, readOnly);
  }

  async navigationRevisions(revset: string): Promise<Revision[]> {
    return logRevisions(this.root, revset);
  }

  async rebaseScope(revision: Revision, operationId = "@"): Promise<Revision[]> {
    return logRevisions(this.root, `${revision.commitId}::`, operationId);
  }

  async diff(revision: Revision, files: string[] = []): Promise<string> {
    return terminalText(await run(this.root, ["--ignore-working-copy", "--at-op=@", "diff", "--revision", revision.commitId, "--git", "--", ...files.map(literalPath)]));
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

  async evolution(revision: Revision, options: { limit?: number; operationId?: string } = {}): Promise<EvolutionPage> {
    const limit = options.limit ?? 50;
    const operationId = options.operationId ?? await this.operationId();
    const output = await run(this.root, ["--at-op", operationId, "evolog", "--config", "ui.log-word-wrap=false", "--no-graph", "-r", revision.commitId,
      "--limit", String(limit + 1), "-T",
      `'[' ++ json(commit.commit_id()) ++ ',' ++ json(commit.description()) ++ ',' ++ json(operation.description()) ++ ',' ++ json(stringify(operation.time())) ++ ']\n'`]);
    const entries = tuples(output).map(([id, description, operationDescription, time]) => {
      const commitId = string(id);
      if (!/^[0-9a-f]{40,64}$/.test(commitId)) throw new Error("Unexpected commit ID in jj evolution output.");
      return { commitId, description: string(description), operationDescription: string(operationDescription), time: string(time) };
    });
    return { operationId, entries: entries.slice(0, limit), hasMore: entries.length > limit };
  }

  async evolutionDiff(operationId: string, entry: EvolutionEntry): Promise<string> {
    const patch = await run(this.root, ["--at-op", operationId, "evolog", "--no-graph", "-r", entry.commitId,
      "--limit", "1", "--git", "--patch", "-T", '""']);
    return terminalText(`${entry.description.trimEnd() || "(no description)"}\n\nCommit ${entry.commitId}\n${entry.operationDescription}\n${entry.time}\n\nChanges introduced in this version:\n${patch.trim() || "No content or description changes in this version."}`);
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
    await runInteractive(this.root, action);
  }

  async openHunk(revision: Revision): Promise<void> {
    await openHunk(this.root, revision);
  }

  async prepare(action: Mutation): Promise<PreparedMutation> {
    await this.status();
    const operationId = await this.operationId();
    const targets = "revision" in action ? [action.revision] : action.kind === "new" ? [action.parent] : [];
    if ("destination" in action) targets.push(action.destination);
    for (const revision of targets) {
      const visible = await this.snapshot(`present(${revision.changeId})`);
      if (!visible.revisions.some(current => current.commitId === revision.commitId)) {
        throw new Error("The selected revision has changed. Refresh and select it again.");
      }
    }
    let summary: string;
    let rebasing: Revision[] = [];
    switch (action.kind) {
      case "describe": summary = `Describe ${label(action.revision)}\n\n${action.description}`; break;
      case "new": summary = `Create an empty child of ${label(action.parent)}`; break;
      case "edit": summary = `Make this change the working copy:\n${label(action.revision)}`; break;
      case "absorb": summary = await projectedAbsorb(this.root, action.revision, operationId); break;
      case "abandon":
      case "rebase": {
        summary = `${action.kind === "abandon" ? "Abandon" : "Rebase"} ${label(action.revision)}\n`;
        if (action.kind === "rebase") summary += `Onto ${label(action.destination)}\nMode: ${action.descendants ? "selected revision and descendants" : "selected revision only; descendants fill the gap"}\n`;
        if (action.kind === "rebase" && action.descendants) {
          rebasing = await this.rebaseScope(action.revision, operationId);
          summary += `\n${rebaseScopeSummary(rebasing)}\n\nTrees show up to 40 revisions; the list above includes the full rebase scope.`;
        } else {
          const affected = await this.snapshot(`${action.revision.commitId}::`);
          summary += `\nAffected revision/descendant context (up to 200):\n${affected.revisions.map(label).join("\n")}`;
        }
        summary += "\n\nDescendants may be rewritten and conflicts may result.";
        break;
      }
      case "squash":
        summary = `Squash from ${label(action.revision)}\nInto ${label(action.destination)}\nFiles: ${action.files.length ? action.files.join(", ") : "all"}\nThe source is abandoned if emptied.\nDestination description:\n${action.description}\n\n${await this.diff(action.revision, action.files)}`;
        break;
      case "split": {
        const files = await this.files(action.revision);
        if (!action.files.length || action.files.length >= files.length || action.files.some(path => !files.some(file => file.path === path))) throw new Error("Select some, but not all, changed files to split.");
        summary = `Split ${label(action.revision)}\n\nFirst change: ${action.description}\n${action.files.join("\n")}\n\nSecond change: ${action.secondDescription}\n${files.filter(file => !action.files.includes(file.path)).map(file => file.path).join("\n")}\n\nThe combined file contents are preserved.`;
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
      ? await projectedTree(this.root, action, operationId, rebasing) : null;
    if (await this.operationId() !== operationId) throw new Error("Repository changed while preparing the preview. Try again.");
    return { action, operationId, summary: terminalText(summary), trees };
  }

  async apply(prepared: PreparedMutation): Promise<void> {
    await this.status();
    if (await this.operationId() !== prepared.operationId) throw new Error("Repository changed since this preview. Review the action again before applying.");
    if (prepared.action.kind === "split") await runSplit(this.root, prepared.action);
    else await run(this.root, mutationArgs(prepared.action));
  }
}
