import { label, type Bookmark, type PreparedMutation, type Remote, type RemoteMutation } from "./model";
import { run } from "./jj-process";
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

type PublishAction = Extract<RemoteMutation, { kind: "git-publish" }>;
function publishState(action: PublishAction, bookmarks: Bookmark[]) {
  const local = bookmarks.find(item => !item.remote && item.name === action.name);
  const remote = bookmarks.find(item => item.remote === action.remote && item.name === action.name);
  if (local?.conflict || remote?.conflict) throw new Error("Resolve this bookmark's conflict before pushing.");
  if (remote && !remote.tracked) throw new Error(`${action.name}@${action.remote} already exists and is not tracked. Track it from the bookmark browser, or choose another name.`);
  return { local, remote, placed: local?.targets.length === 1 && local.targets[0] === action.revision.commitId };
}

async function preparePublish(root: string, action: PublishAction, bookmarks: Bookmark[], operationId: string) {
  if (!action.name) throw new Error("Enter a bookmark name.");
  const { local, remote, placed } = publishState(action, bookmarks);
  const target = action.revision.commitId;
  const commits = await logRevisions(root, `(::${target} ~ ::remote_bookmarks(remote=exact:${JSON.stringify(action.remote)})) ~ root()`, operationId);
  // JJ rejects these at push time, after the bookmark would already have been created.
  const blocked = commits.find(item => item.conflict || !item.description.trim());
  if (blocked) throw new Error(`JJ will not push ${label(blocked)} because it ${blocked.conflict ? "has conflicts. Resolve them" : "has no description. Describe it"} first.`);
  const previous = remote?.targets.join(", ");
  let summary = `Publish ${label(action.revision)}\n\n`;
  summary += `Bookmark: ${action.name} (${placed ? "already on this change" : local?.targets.length ? `move from ${local.targets.join(", ")}` : "create"})\n`;
  summary += `Tracking: ${remote ? "already tracking" : "start tracking"} ${action.name}@${action.remote}\n`;
  summary += `Push:     ${previous === target ? "remote is already up to date" : previous ? `move ${action.name}@${action.remote} from ${previous} to ${target}` : `add ${action.name}@${action.remote} at ${target}`}\n\n`;
  summary += commits.length ? `Commits to publish (${commits.length}):\n${commits.map(item => `  ${label(item)}`).join("\n")}` : "No new commits to publish.";
  return summary;
}

async function applyPublish(root: string, action: PublishAction, bookmarks: Bookmark[]) {
  const { local, remote, placed } = publishState(action, bookmarks);
  if (!placed) await run(root, ["bookmark", ...(local ? ["set", "--allow-backwards"] : ["create"]), "--revision", action.revision.commitId, "--", action.name]);
  if (!remote) await run(root, mutationArgs({ kind: "bookmark-track", remote: action.remote, name: action.name }));
  const operationId = (await run(root, ["--ignore-working-copy", "op", "log", "--no-graph", "--limit", "1", "-T", "id"])).trim();
  try { await network(root, ["--at-op", operationId, ...mutationArgs(action)]); }
  catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nThe local bookmark ${action.name} is set and tracks ${action.remote}; only the push failed. Publish again to retry.`);
  }
}

async function network(root: string, args: string[]): Promise<string> {
  try { return await run(root, args, true); }
  catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRemote operation failed. For authentication, configure Git credentials or SSH in your terminal. After a rejected push, fetch and review again. If the connection was interrupted, fetch to check the remote before retrying.`);
  }
}

export async function prepareRemote(root: string, action: RemoteMutation, bookmarks: Bookmark[], operationId: string) {
  const remote = (await remoteList(root)).find(item => item.name === action.remote);
  if (!remote) throw new Error("This Git remote no longer exists. Reload remotes.");
  let summary = `Remote: ${remote.name}\nURL: ${remote.url}\n\n`;
  if (action.kind === "git-fetch") {
    summary += "Fetch bookmarks and commits from this remote. Tracked bookmarks may update local bookmarks and the working copy. No local commits are pushed.";
  } else if (action.kind === "git-publish") {
    summary += await preparePublish(root, action, bookmarks, operationId);
    summary += "\n\nThis publishes commits to the remote. Local undo cannot undo a push. JJ rejects a push if the remote changed since the last fetch.";
  } else if (action.kind === "git-push") {
    const local = bookmarks.find(item => !item.remote && item.name === action.name);
    const previous = bookmarks.find(item => item.remote === remote.name && item.name === action.name);
    if (!local && !previous?.tracked) throw new Error("No local or tracked deleted bookmark to push.");
    if (local?.conflict || previous?.conflict) throw new Error("Resolve this bookmark's conflict before pushing.");
    summary += `Push only bookmark: ${action.name}\nLast fetched target: ${previous?.targets.join(", ") || "(absent)"}\nNew target: ${local?.targets.join(", ") || "(delete remote bookmark)"}\n\n`;
    summary += await network(root, ["--at-op", operationId, ...mutationArgs(action), "--dry-run"]);
    summary += "\nThis publishes commits to the remote. Local undo cannot undo a push. JJ rejects a push if the remote changed since the last fetch.";
  } else {
    const bookmark = bookmarks.find(item => item.remote === remote.name && item.name === action.name);
    if (!bookmark) throw new Error("This remote bookmark no longer exists. Fetch and reload bookmarks.");
    summary += `${action.kind === "bookmark-track" ? "Track" : "Untrack"} ${action.name}@${remote.name}\nTargets: ${bookmark.targets.join(", ")}\n\n`;
    summary += action.kind === "bookmark-track"
      ? "Import this remote bookmark as a local bookmark. Future fetches update it; a differing local bookmark may become conflicted."
      : "Stop propagating future remote updates to the local bookmark. The local bookmark and remote target remain.";
  }
  return { summary, remoteUrl: remote.url };
}

export async function applyRemote(root: string, prepared: PreparedMutation, bookmarks: Bookmark[]): Promise<void> {
  const action = prepared.action;
  if (!("remote" in action)) throw new Error("Expected a remote action.");
  const remote = (await remoteList(root)).find(item => item.name === action.remote);
  if (!remote || remote.url !== prepared.remoteUrl) throw new Error("Remote configuration changed since this preview. Review the action again.");
  if (action.kind === "git-publish") { await applyPublish(root, action, bookmarks); return; }
  // Pin the operation so concurrent local edits cannot change the reviewed push targets.
  const args = ["--at-op", prepared.operationId, ...mutationArgs(action)];
  if (action.kind === "git-push" || action.kind === "git-fetch") await network(root, args);
  else await run(root, args);
}
