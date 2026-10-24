import { label, type Bookmark, type Mutation, type PreparedMutation, type PublishBookmarks, type Remote, type RemoteMutation, type Revision } from "./model";
import { CancelledError, NETWORK_TIMEOUT_MS, run } from "./jj-process";
import { logRevisions } from "./log-snapshot";
import { mutationArgs } from "./mutation";

export async function remoteList(root: string): Promise<Remote[]> {
  const output = await run(root, ["--ignore-working-copy", "git", "remote", "list"]);
  return output.trim().split("\n").filter(Boolean).map(line => {
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error("Unexpected jj remote list output.");
    return { name: match[1], url: match[2] };
  });
}

// The remote `jj git push` uses without --remote: the git.push setting, else origin; a lone remote is unambiguous.
export async function defaultPushRemote(root: string, remotes: Remote[]): Promise<Remote | undefined> {
  const configured = (await run(root, ["--ignore-working-copy", "config", "get", "git.push"]).catch(() => "")).trim();
  return remotes.find(item => item.name === configured) ?? remotes.find(item => item.name === "origin") ?? (remotes.length === 1 ? remotes[0] : undefined);
}

// Immutable ancestors are left out, so a change stacked on main is never offered "advance main and push".
export async function publishBookmarks(root: string, revision: Revision, bookmarks: Bookmark[]): Promise<PublishBookmarks> {
  const on = (commitId: string) => bookmarks.filter(item => !item.remote && item.targets.includes(commitId)).map(item => item.name);
  const here = on(revision.commitId);
  if (here.length) return { names: here, advance: false };
  const ancestors = await logRevisions(root, `heads(::${revision.commitId} & bookmarks() & mutable())`);
  return { names: [...new Set(ancestors.flatMap(item => on(item.commitId)))], advance: true };
}

// The name `jj git push --change` would create, from the templates.git_push_bookmark setting.
export async function generatedBookmarkName(root: string, revision: Revision): Promise<string> {
  const template = (await run(root, ["--ignore-working-copy", "config", "get", "templates.git_push_bookmark"]).catch(() => "")).trim();
  if (!template) return "";
  return (await run(root, ["--ignore-working-copy", "log", "--no-graph", "-r", revision.commitId, "-T", template]).catch(() => "")).trim();
}

type PublishAction = Extract<RemoteMutation, { kind: "git-publish" }>;
function publishState(action: PublishAction, bookmarks: Bookmark[]) {
  const local = bookmarks.find(item => !item.remote && item.name === action.name);
  const remote = bookmarks.find(item => item.remote === action.remote && item.name === action.name);
  if (local?.conflict || remote?.conflict) throw new Error("Resolve this bookmark's conflict before pushing.");
  if (remote && !remote.tracked) throw new Error(`${action.name}@${action.remote} already exists and is not tracked. Track it from the bookmark browser, or choose another name.`);
  return { local, remote, placed: local?.targets.length === 1 && local.targets[0] === action.revision.commitId };
}

// A publish has no dry run to read, so it gets the same caution as a push from the remote bookmark's ancestry.
async function publishCaution(root: string, action: PublishAction, previous: string, operationId: string): Promise<string | undefined> {
  const target = action.revision.commitId;
  if (!previous || previous === target) return undefined;
  if ((await logRevisions(root, `${previous} & ::${target}`, operationId)).length) return undefined;
  const direction = (await logRevisions(root, `${target} & ::${previous}`, operationId)).length ? "backward" : "sideways";
  return `This moves ${action.name}@${action.remote} ${direction}; commits now on the remote bookmark will no longer be reachable from it.`;
}

async function preparePublish(root: string, action: PublishAction, bookmarks: Bookmark[], operationId: string): Promise<{ summary: string; caution?: string }> {
  if (!action.name) throw new Error("Enter a bookmark name.");
  const { local, remote, placed } = publishState(action, bookmarks);
  const target = action.revision.commitId;
  const commits = await logRevisions(root, `(::${target} ~ ::remote_bookmarks(remote=exact:${JSON.stringify(action.remote)})) ~ root()`, operationId);
  // JJ rejects these at push time, after the bookmark would already have been created.
  const blocked = commits.find(item => item.conflict || !item.description.trim());
  if (blocked) throw new Error(`JJ will not push ${label(blocked)} because it ${blocked.conflict ? "has conflicts. Resolve them" : "has no description. Describe it"} first.`);
  const previous = remote?.targets.join(", ");
  // A bookmark on an ancestor advances. The ancestor's own row proves the ancestry and is not counted.
  const old = !placed && local?.targets.length === 1 ? local.targets[0]! : "";
  const path = old ? await logRevisions(root, `(${old} & ::${target}) | ${old}..${target}`, operationId) : [];
  const advance = path.some(item => item.commitId === old) ? path.length - 1 : 0;
  let summary = `Publish ${label(action.revision)}\n\n`;
  const count = `${advance} ${advance === 1 ? "commit" : "commits"}`;
  if (advance) summary += `Advance bookmark ${action.name} by ${count} to this change, then push it.\n  from ${old}\n  to   ${target}\n\n`;
  summary += `Bookmark: ${action.name} (${placed ? "already on this change" : advance ? `advance ${count}` : local?.targets.length ? `move from ${local.targets.join(", ")}` : "create"})\n`;
  summary += `Tracking: ${remote ? "already tracking" : "start tracking"} ${action.name}@${action.remote}\n`;
  summary += `Push:     ${previous === target ? "remote is already up to date" : previous ? `move ${action.name}@${action.remote} from ${previous} to ${target}` : `add ${action.name}@${action.remote} at ${target}`}\n\n`;
  summary += commits.length ? `Commits to publish (${commits.length}):\n${commits.map(item => `  ${label(item)}`).join("\n")}` : "No new commits to publish.";
  const caution = await publishCaution(root, action, remote?.targets.length === 1 ? remote.targets[0]! : "", operationId);
  return { summary, ...(caution ? { caution } : {}) };
}

// The whole publish is cancellable, so Escape during its local steps stops the push before it starts; the local
// commands themselves never receive the signal, so none of them is interrupted halfway.
async function applyPublish(root: string, action: PublishAction, bookmarks: Bookmark[], signal: AbortSignal): Promise<string> {
  const { local, remote, placed } = publishState(action, bookmarks);
  if (!placed) await run(root, ["bookmark", ...(local ? ["set", "--allow-backwards"] : ["create"]), "--revision", action.revision.commitId, "--", action.name]);
  if (!remote) await run(root, mutationArgs({ kind: "bookmark-track", remote: action.remote, name: action.name }));
  try { return pushReport("Published", action, await network(root, ["--at-op", await latestOperation(root), ...mutationArgs(action)], signal)); }
  catch (error) {
    const kept = `The local bookmark ${action.name} is set and tracks ${action.remote}`;
    if (error instanceof CancelledError && !error.started) throw new Error(`Publish cancelled before the push started; nothing was sent to ${action.remote}.\n${kept}. Publish again to push it.`);
    const reason = error instanceof CancelledError ? "Push cancelled. The remote may already have the new target; fetch to check" : error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\n${kept}; only the push failed. Publish again to retry.`);
  }
}

type DeleteAction = Extract<Mutation, { kind: "bookmark-delete" }>;
// A dry run cannot show the push of a deletion that has not happened yet, so the review is computed from bookmark state.
export async function prepareDeletion(root: string, action: DeleteAction, bookmarks: Bookmark[]): Promise<{ summary: string; remoteUrl?: string }> {
  const tracked = bookmarks.find(item => item.remote === action.remote && item.name === action.name && item.tracked && item.targets.length);
  const there = `${action.name}@${action.remote}`;
  if (!action.push) return { summary: tracked ? `Local deletion only. ${there} stays on the remote, where a later push of this bookmark would delete it.` : "Local deletion only. Remote bookmarks are not pushed." };
  if (!tracked) throw new Error(`${there} is no longer a tracked remote bookmark. Reload bookmarks.`);
  const remote = (await remoteList(root)).find(item => item.name === action.remote);
  if (!remote) throw new Error("This Git remote no longer exists. Reload remotes.");
  return { remoteUrl: remote.url, summary: `Then push the deletion to ${remote.name} (${remote.url}):\n  delete ${there}, last fetched at ${tracked.targets.join(", ")}\n\nDeleting the bookmark on ${remote.name} cannot be undone locally: undo restores only the local bookmark. JJ rejects the push if the remote changed since the last fetch.` };
}

// Like a publish, the whole deletion is cancellable: Escape during the local deletion stops the push before it starts.
async function applyDeletion(root: string, action: DeleteAction & { remote: string }, signal: AbortSignal): Promise<string> {
  await run(root, mutationArgs(action));
  try {
    const output = await network(root, ["--at-op", await latestOperation(root), ...mutationArgs({ kind: "git-push", remote: action.remote, name: action.name })], signal);
    const change = pushChanges(output).find(item => item.name === action.name);
    return `Deleted ${action.name} here and on ${action.remote}${change?.kind === "delete" ? `\nwas ${short(change.from)}` : ""}`;
  }
  catch (error) {
    const retry = `To retry, open the bookmark browser and choose ${action.name}, then Push deletion. To keep the bookmark instead, undo the deletion.`;
    if (error instanceof CancelledError && !error.started) throw new Error(`Deletion cancelled before the push started; nothing was sent to ${action.remote}.\nThe local bookmark ${action.name} was deleted, but ${action.name}@${action.remote} still exists. ${retry}`);
    if (error instanceof CancelledError) throw new Error(`Push cancelled. ${action.name}@${action.remote} may already be deleted; fetch to check.\nThe local bookmark ${action.name} was deleted. ${retry}`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nThe local bookmark ${action.name} was deleted, but ${action.name}@${action.remote} still exists; only the push failed. ${retry}`);
  }
}

async function latestOperation(root: string): Promise<string> {
  return (await run(root, ["--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id"])).trim();
}

/** Runs the network part of a remote action, giving it the signal that cancels it. */
export type NetworkScope = <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
const uncancellable: NetworkScope = work => work(new AbortController().signal);

// A large fetch can take minutes, so network commands get a long backstop timeout and the caller cancels them through the signal.
async function network(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  try { return await run(root, args, true, {}, { timeoutMs: NETWORK_TIMEOUT_MS, signal }); }
  catch (error) {
    if (error instanceof CancelledError) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRemote operation failed. For authentication, configure Git credentials or SSH in your terminal. After a rejected push, fetch and push again. If the connection was interrupted, fetch to check the remote before retrying.`);
  }
}

export interface PushChange { name: string; kind: "add" | "forward" | "backward" | "sideways" | "delete"; from?: string; to?: string }

// jj prints a bookmark name bare, or as a quoted string literal when it is not plain ASCII, such as `"é"` or `"a b"`.
const bookmarkName = String.raw`("(?:[^"\\]|\\.)*"|\S+?)`;
function unquote(name: string): string {
  if (!name.startsWith('"')) return name;
  try { return String(JSON.parse(name)); } catch { return name.slice(1, -1); }
}

/** Reads the bookmark lines `jj git push` prints, with or without --dry-run. */
export function pushChanges(output: string): PushChange[] {
  const changes: PushChange[] = [];
  const pattern = new RegExp(String.raw`^\s*bookmark: ${bookmarkName} \[(?:add to ([0-9a-f]+)|move (forward|backward|sideways) from ([0-9a-f]+) to ([0-9a-f]+)|delete from ([0-9a-f]+))\]`);
  for (const line of output.split("\n")) {
    const match = pattern.exec(line);
    if (!match) continue;
    const [, quoted = "", added, direction, from, to, deleted] = match;
    const name = unquote(quoted);
    if (added) changes.push({ name, kind: "add", to: added });
    else if (deleted) changes.push({ name, kind: "delete", from: deleted });
    else changes.push({ name, kind: direction as PushChange["kind"], from, to });
  }
  return changes;
}

const short = (id = "") => id.slice(0, 8);
function describeChange(change: PushChange): string {
  switch (change.kind) {
    case "add": return `added at ${short(change.to)}`;
    case "delete": return `deleted (was ${short(change.from)})`;
    default: return `moved ${change.kind} ${short(change.from)} → ${short(change.to)}`;
  }
}

// jj prints this, and no bookmark line, when the remote already has the pushed target.
const unchanged = (output: string) => /^Nothing changed\.$/m.test(output);

/**
 * Why a push should stop for review: it deletes the remote bookmark or drops commits from it.
 * A dry run whose effect on the bookmark cannot be read also stops, so an unexpected output format fails safe.
 */
export function pushCaution(name: string, remote: string, dryRun: string): string | undefined {
  const change = pushChanges(dryRun).find(item => item.name === name);
  if (!change) return unchanged(dryRun) ? undefined : `jj's dry run does not say how this push changes ${name}@${remote}; check its output below.`;
  if (change.kind === "delete") return `This deletes ${change.name} on ${remote}.`;
  if (change.kind === "backward" || change.kind === "sideways") return `This moves ${change.name}@${remote} ${change.kind}; commits now on the remote bookmark will no longer be reachable from it.`;
  return undefined;
}

function pushReport(verb: string, action: { remote: string; name: string }, output: string): string {
  const change = pushChanges(output).find(item => item.name === action.name);
  if (change) return `${verb} ${action.name} to ${action.remote}\n${describeChange(change)}`;
  return unchanged(output) ? `${action.name} is already up to date on ${action.remote}` : `${verb} ${action.name} to ${action.remote}`;
}

/** Summarizes the bookmark lines `jj git fetch` prints, such as `bookmark: main@origin [updated] tracked`. */
export function fetchReport(remote: string, output: string): string {
  const changes = [...output.matchAll(new RegExp(String.raw`^bookmark: ${bookmarkName}@\S+ \[(\w+)\]`, "gm"))].map(match => `${unquote(match[1] ?? "")} ${match[2]}`);
  if (!changes.length) return `Fetched ${remote}\nalready up to date`;
  const shown = changes.slice(0, 3).join(", ");
  return `Fetched ${remote} · ${changes.length} bookmark${changes.length === 1 ? "" : "s"} changed\n${shown}${changes.length > 3 ? `, +${changes.length - 3} more` : ""}`;
}

export async function prepareRemote(root: string, action: RemoteMutation, bookmarks: Bookmark[], operationId: string, scope = uncancellable) {
  const remote = (await remoteList(root)).find(item => item.name === action.remote);
  if (!remote) throw new Error("This Git remote no longer exists. Reload remotes.");
  let summary = `Remote: ${remote.name}\nURL: ${remote.url}\n\n`;
  let caution: string | undefined;
  if (action.kind === "git-fetch") {
    summary += "Fetch bookmarks and commits from this remote. Tracked bookmarks may update local bookmarks and the working copy. No local commits are pushed.";
  } else if (action.kind === "git-publish") {
    const publish = await preparePublish(root, action, bookmarks, operationId);
    caution = publish.caution;
    summary = `${caution ? `Warning: ${caution}\n\n` : ""}${summary}${publish.summary}`;
    summary += "\n\nThis publishes commits to the remote. Local undo cannot undo a push. JJ rejects a push if the remote changed since the last fetch.";
  } else if (action.kind === "git-push") {
    const local = bookmarks.find(item => !item.remote && item.name === action.name);
    const previous = bookmarks.find(item => item.remote === remote.name && item.name === action.name);
    if (!local && !previous?.tracked) throw new Error("No local or tracked deleted bookmark to push.");
    if (local?.conflict || previous?.conflict) throw new Error("Resolve this bookmark's conflict before pushing.");
    summary += `Push only bookmark: ${action.name}\nLast fetched target: ${previous?.targets.join(", ") || "(absent)"}\nNew target: ${local?.targets.join(", ") || "(delete remote bookmark)"}\n\n`;
    const dryRun = await scope(signal => network(root, ["--at-op", operationId, ...mutationArgs(action), "--dry-run"], signal));
    caution = pushCaution(action.name, remote.name, dryRun);
    if (caution) summary = `Warning: ${caution}\n\n${summary}`;
    summary += dryRun;
    summary += "\nThis publishes commits to the remote. Local undo cannot undo a push. JJ rejects a push if the remote changed since the last fetch.";
  } else {
    const bookmark = bookmarks.find(item => item.remote === remote.name && item.name === action.name);
    if (!bookmark) throw new Error("This remote bookmark no longer exists. Fetch and reload bookmarks.");
    summary += `${action.kind === "bookmark-track" ? "Track" : "Untrack"} ${action.name}@${remote.name}\nTargets: ${bookmark.targets.join(", ")}\n\n`;
    summary += action.kind === "bookmark-track"
      ? "Import this remote bookmark as a local bookmark. Future fetches update it; a differing local bookmark may become conflicted."
      : "Stop propagating future remote updates to the local bookmark. The local bookmark and remote target remain.";
  }
  return { summary, remoteUrl: remote.url, ...(caution ? { caution } : {}) };
}

/** Applies a reviewed remote action and returns a short report of what changed, or null for tracking changes. */
export async function applyRemote(root: string, prepared: PreparedMutation, bookmarks: Bookmark[], scope = uncancellable): Promise<string | null> {
  const action = prepared.action;
  if (!("remote" in action)) throw new Error("Expected a remote action.");
  const remote = (await remoteList(root)).find(item => item.name === action.remote);
  if (!remote || remote.url !== prepared.remoteUrl) throw new Error("Remote configuration changed since this preview. Review the action again.");
  if (action.kind === "git-publish") return await scope(signal => applyPublish(root, action, bookmarks, signal));
  if (action.kind === "bookmark-delete") return await scope(signal => applyDeletion(root, { ...action, remote: remote.name }, signal));
  // Pin the operation so concurrent local edits cannot change the reviewed push targets.
  const args = ["--at-op", prepared.operationId, ...mutationArgs(action)];
  if (action.kind === "git-fetch") {
    try { return fetchReport(action.remote, await scope(signal => network(root, args, signal))); }
    catch (error) { if (error instanceof CancelledError) throw new Error("Fetch cancelled."); throw error; }
  }
  if (action.kind === "git-push") {
    try { return pushReport("Pushed", action, await scope(signal => network(root, args, signal))); }
    catch (error) {
      if (error instanceof CancelledError) throw new Error(error.started ? `Push cancelled. ${action.name}@${action.remote} may already have the new target; fetch to check before pushing again.` : `Push cancelled before it started; nothing was sent to ${action.remote}.`);
      throw error;
    }
  }
  await run(root, args);
  return null;
}
