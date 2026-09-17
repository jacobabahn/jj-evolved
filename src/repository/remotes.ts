import type { Bookmark, PreparedMutation, Remote, RemoteMutation } from "./model";
import { run } from "./jj-process";
import { mutationArgs } from "./mutation";

export async function remoteList(root: string): Promise<Remote[]> {
  const output = await run(root, ["--ignore-working-copy", "git", "remote", "list"]);
  return output.trim().split("\n").filter(Boolean).map(line => {
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error("Unexpected jj remote list output.");
    return { name: match[1], url: match[2] };
  });
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

export async function applyRemote(root: string, prepared: PreparedMutation): Promise<void> {
  const action = prepared.action;
  if (!("remote" in action)) throw new Error("Expected a remote action.");
  const remote = (await remoteList(root)).find(item => item.name === action.remote);
  if (!remote || remote.url !== prepared.remoteUrl) throw new Error("Remote configuration changed since this preview. Review the action again.");
  // Pin the operation so concurrent local edits cannot change the reviewed push targets.
  const args = ["--at-op", prepared.operationId, ...mutationArgs(action)];
  if (action.kind === "git-push" || action.kind === "git-fetch") await network(root, args);
  else await run(root, args);
}
