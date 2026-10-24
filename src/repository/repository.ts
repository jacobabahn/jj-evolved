import { label, rebaseScopeSummary, isRealRemote, shortChangeId, type TrunkRebase, type Remote, type PublishBookmarks, type EvolutionEntry, type EvolutionPage, type Revision, type Snapshot, type Mutation, type InteractiveAction, type Operation, type Bookmark, type ChangedFile, type PreparedMutation } from "./model";
import { remoteList, defaultPushRemote, publishBookmarks, generatedBookmarkName, prepareRemote, prepareDeletion, applyRemote, type NetworkScope } from "./remotes";
import { run } from "./jj-process";
import { logSnapshot, logRevisions } from "./log-snapshot";
import { literalPath, mutationArgs } from "./mutation";
import { projectedAbsorb } from "./projected-absorb";
import { projectedTree } from "./projected-tree";
import { runInteractive, openHunk, editDescription } from "./external-tools";
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
function number(value: unknown): number {
  if (typeof value !== "number") throw new Error("Unexpected jj template field.");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Unexpected jj template record.");
  return value;
}
function tuples(output: string): unknown[][] {
  return output.split("\n").filter(Boolean).map(line => array(JSON.parse(line)));
}
const diffKey = (revision: Revision, files: string[]) => [revision.commitId, ...files].join("\0");
export class Repository {
  // A commit ID fixes the diff against its parents, but config such as conflict-marker style can change the text; refreshes clear it.
  diffCacheLimits = { entries: 64, chars: 16_000_000, entryChars: 2_000_000 };
  private readonly diffs = new Map<string, string>();
  private readonly pendingDiffs = new Map<string, Promise<string>>();
  private diffChars = 0;
  private diffGeneration = 0;
  private networkAbort: AbortController | null = null;
  /** Called when a fetch or push starts or finishes, so the app can show or hide its cancel key. */
  onNetworkChange: (() => void) | null = null;
  private constructor(readonly root: string) {}

  static async open(path: string): Promise<Repository> {
    return new Repository((await run(path, ["root"])).trim());
  }

  async snapshot(revset: string, readOnly = false, limit = 200): Promise<Snapshot> {
    return logSnapshot(this.root, revset, readOnly, limit);
  }

  // The revset `jj log` shows without -r, so the default view matches jj and jjui.
  async logRevset(): Promise<string> {
    const configured = await run(this.root, ["--ignore-working-copy", "config", "get", "revsets.log"]).catch(() => "");
    return configured.trim() || "all()";
  }

  async navigationRevisions(revset: string): Promise<Revision[]> {
    return logRevisions(this.root, revset);
  }

  async rebaseScope(revision: Revision, operationId = "@"): Promise<Revision[]> {
    return logRevisions(this.root, `${revision.commitId}::`, operationId);
  }

  // `jj rebase -b X -d D` is `-s roots(D..X) -d D`, so a stack with one root is the existing rebase with descendants.
  async trunkRebase(revision: Revision): Promise<TrunkRebase> {
    const id = revision.commitId, name = shortChangeId(revision);
    const [trunks, roots, immutable] = await Promise.all([
      logRevisions(this.root, "trunk()"), logRevisions(this.root, `roots(trunk()..${id})`), logRevisions(this.root, `${id} & immutable()`),
    ]);
    const [trunk] = trunks, [root] = roots;
    if (!trunk) throw new Error("trunk() does not resolve to a revision in this repository.");
    if (trunk.commitId === id) return { kind: "blocked", reason: `${name} is trunk itself, so there is no stack to sync.` };
    if (immutable.length) return { kind: "blocked", reason: `${name} is immutable, so its stack cannot be rebased onto trunk.` };
    if (!root) return { kind: "current", reason: "Already part of trunk; nothing to rebase." };
    if (roots.length > 1) return { kind: "blocked", reason: `This stack has ${roots.length} roots, which the rebase preview cannot show. Run jj rebase -b ${name} -d 'trunk()' in a terminal.` };
    if (root.parents.length === 1 && root.parents[0] === trunk.commitId) return { kind: "current", reason: `Already based on trunk (${shortChangeId(trunk)}); nothing to rebase.` };
    return { kind: "rebase", action: { kind: "rebase", revision: root, destination: trunk, descendants: true } };
  }

  async diff(revision: Revision, files: string[] = []): Promise<string> {
    const cached = this.cachedDiff(revision, files);
    if (cached !== undefined) return cached;
    const key = diffKey(revision, files);
    const existing = this.pendingDiffs.get(key);
    if (existing) return existing;
    const generation = this.diffGeneration;
    const pending: Promise<string> = run(this.root, ["--ignore-working-copy", "--at-op=@", "diff", "--revision", revision.commitId, "--git", "--", ...files.map(literalPath)]).then(output => {
      const text = terminalText(output);
      const { entries, chars, entryChars } = this.diffCacheLimits;
      if (generation !== this.diffGeneration || text.length > entryChars) return text;
      this.diffs.set(key, text);
      this.diffChars += text.length;
      for (const [oldest, value] of this.diffs) {
        if (this.diffs.size <= entries && this.diffChars <= chars) break;
        this.diffs.delete(oldest);
        this.diffChars -= value.length;
      }
      return text;
    }).finally(() => { if (this.pendingDiffs.get(key) === pending) this.pendingDiffs.delete(key); });
    this.pendingDiffs.set(key, pending);
    return pending;
  }

  clearDiffs() {
    ++this.diffGeneration;
    this.diffs.clear();
    this.pendingDiffs.clear();
    this.diffChars = 0;
  }

  cachedDiff(revision: Revision, files: string[] = []): string | undefined {
    const key = diffKey(revision, files);
    const cached = this.diffs.get(key);
    if (cached !== undefined) { this.diffs.delete(key); this.diffs.set(key, cached); }
    return cached;
  }

  async status(): Promise<string> {
    return terminalText(await run(this.root, ["status"]));
  }

  async operationId(): Promise<string> {
    return (await run(this.root, ["--ignore-working-copy", "--at-op=@", "op", "log", "--no-graph", "--limit", "1", "-T", "id"])).trim();
  }

  // Snapshots pending working-copy edits first, so external file changes produce a new ID.
  async snapshotOperationId(): Promise<string> {
    return (await run(this.root, ["op", "log", "--no-graph", "--limit", "1", "-T", "id"])).trim();
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
    // JJ counts from the remote's side, so its "behind" is how far the local bookmark is ahead. Only tracked remotes have counts.
    const [output, remotes] = await Promise.all([run(this.root, ["--ignore-working-copy", "--at-op=@", "bookmark", "list", "--all-remotes", "-T",
      `'[' ++ json(name) ++ ',' ++ json(if(remote, stringify(remote), "")) ++ ',' ++ json(added_targets.map(|c| c.commit_id())) ++ ',' ++ json(conflict) ++ ',' ++ json(tracked) ++ if(remote && tracked, ',' ++ json(tracking_behind_count.lower()) ++ ',' ++ json(tracking_ahead_count.lower())) ++ ']\n'`]),
      this.remotes().catch(() => [])]);
    const bookmarks = tuples(output).map(([name, remote, targets, conflict, tracked, ahead, behind]): Bookmark => ({
      tracked: boolean(tracked), name: string(name), remote: string(remote), targets: array(targets).map(string), conflict: boolean(conflict),
      ...(ahead === undefined ? {} : { ahead: number(ahead), behind: number(behind) }),
    }));
    if (!remotes.length) return bookmarks;
    const pushed = new Set(bookmarks.filter(item => isRealRemote(item) && item.tracked && item.targets.length).map(item => item.name));
    return bookmarks.map(item => item.remote || !item.targets.length || pushed.has(item.name) ? item : { ...item, localOnly: true });
  }

  async remotes(): Promise<Remote[]> { return remoteList(this.root); }

  async defaultPushRemote(remotes: Remote[]): Promise<Remote | undefined> { return defaultPushRemote(this.root, remotes); }

  async publishBookmarks(revision: Revision, bookmarks: Bookmark[]): Promise<PublishBookmarks> { return publishBookmarks(this.root, revision, bookmarks); }

  async generatedBookmarkName(revision: Revision): Promise<string> { return generatedBookmarkName(this.root, revision); }

  async files(revision: Revision): Promise<ChangedFile[]> {
    const output = await run(this.root, ["--ignore-working-copy", "diff", "-r", revision.commitId, "-T",
      `'[' ++ json(path) ++ ',' ++ json(status) ++ ']\n'`]);
    return tuples(output).map(([path, status]) => ({ path: string(path), status: string(status) }));
  }

  /** Callers snapshot the working copy first, so these reads can skip it. */
  private async assertCurrent(revisions: Revision[], operationId = "@") {
    const visible = await Promise.all(revisions.map(revision => logRevisions(this.root, `present(${revision.changeId})`, operationId)));
    if (revisions.some((revision, index) => !visible[index]!.some(current => current.commitId === revision.commitId))) {
      throw new Error("The selected revision has changed. Refresh and select it again.");
    }
  }

  async interactive(action: InteractiveAction): Promise<void> {
    await this.status();
    await this.assertCurrent(action.kind === "squash" ? [action.revision, action.destination] : [action.revision]);
    await runInteractive(this.root, action);
  }

  async editDescription(revision: Revision): Promise<void> {
    await this.status();
    await this.assertCurrent([revision]);
    await editDescription(this.root, revision);
  }

  async openHunk(revision: Revision): Promise<void> {
    await openHunk(this.root, revision);
  }

  async prepare(action: Mutation): Promise<PreparedMutation> {
    await this.status();
    const operationId = await this.operationId();
    const targets = "revision" in action ? [action.revision] : action.kind === "new" ? [action.parent] : [];
    if ("destination" in action) targets.push(action.destination);
    await this.assertCurrent(targets, operationId);
    let summary: string;
    let remoteUrl: string | undefined;
    let caution: string | undefined;
    let rebasing: Revision[] = [];
    switch (action.kind) {
      case "git-fetch":
      case "git-push":
      case "git-publish":
      case "bookmark-track":
      case "bookmark-untrack": {
        const preview = await prepareRemote(this.root, action, await this.bookmarks(), operationId, this.withNetwork);
        summary = preview.summary; remoteUrl = preview.remoteUrl; caution = preview.caution;
        break;
      }
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
          const affected = await logRevisions(this.root, `${action.revision.commitId}::`, operationId, 200);
          summary += `\nAffected revision/descendant context (up to 200):\n${affected.map(label).join("\n")}`;
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
        const bookmarks = await this.bookmarks();
        const bookmark = bookmarks.find(item => !item.remote && item.name === action.name);
        if (!bookmark) throw new Error("This local bookmark no longer exists. Reload bookmarks.");
        summary = `${action.kind} ${action.name}\nCurrent targets: ${bookmark.targets.join(", ") || "deleted"}`;
        if (action.kind === "bookmark-move") summary += `\nNew target: ${label(action.revision)}`;
        if (action.kind === "bookmark-rename") summary += `\nNew name: ${action.newName}`;
        if (action.kind === "bookmark-delete") {
          const preview = await prepareDeletion(this.root, action, bookmarks);
          summary += `\n${preview.summary}`; remoteUrl = preview.remoteUrl;
        }
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
    return { action, operationId, summary: terminalText(summary), trees, ...(remoteUrl === undefined ? {} : { remoteUrl }), ...(caution ? { caution } : {}) };
  }

  /** Applies a prepared mutation; remote actions return a short report of what changed. */
  async apply(prepared: PreparedMutation): Promise<string | null> {
    await this.status();
    if (await this.operationId() !== prepared.operationId) throw new Error("Repository changed since this preview. Review the action again before applying.");
    if (prepared.remoteUrl !== undefined) return await applyRemote(this.root, prepared, await this.bookmarks(), this.withNetwork);
    if (prepared.action.kind === "split") await runSplit(this.root, prepared.action);
    else await run(this.root, mutationArgs(prepared.action));
    return null;
  }

  /** True while a fetch or push can be stopped with cancelNetwork(). */
  get networkActive() { return this.networkAbort !== null; }

  /** Stops the running fetch or push, if any. */
  cancelNetwork() { this.networkAbort?.abort(); }

  /** Makes only the fetch or push itself cancellable, not the local steps around it such as tracking changes. */
  private readonly withNetwork: NetworkScope = async work => {
    const controller = new AbortController();
    this.networkAbort = controller;
    this.onNetworkChange?.();
    try { return await work(controller.signal); }
    finally { if (this.networkAbort === controller) { this.networkAbort = null; this.onNetworkChange?.(); } }
  };
}
