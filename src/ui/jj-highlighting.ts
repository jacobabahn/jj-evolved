import { themes, type Theme } from "./theme";
import { StyledText, bold, fg } from "@opentui/core";
import { terminalText } from "../terminal-text";
import type { Revision } from "../repository/model";

export function graphChunks(prefix: string, colors: Theme = themes.terminal) {
  return [...terminalText(prefix)].map(mark => fg(
    mark === "@" ? colors.accent : mark === "◆" ? colors.commit : colors.muted,
  )(mark));
}

export function revisionPrefixes(revisions: Pick<Revision, "changeId" | "changePrefix">[]) {
  return new Map(revisions.map(revision => [revision.changeId, revision.changePrefix]));
}

export function changeIdChunks(id: string, prefix?: string, colors: Theme = themes.terminal) {
  if (!prefix || !id.startsWith(prefix)) return [fg(colors.changeId)(id)];
  return [bold(fg(colors.changeId)(prefix)), fg(colors.muted)(id.slice(prefix.length))];
}

export function highlightJjText(text: string, prefixes: ReadonlyMap<string, string> = new Map(), colors: Theme = themes.terminal): StyledText {
  const idChunks = (id: string) => {
    const matches = [...prefixes].filter(([fullId]) => fullId.startsWith(id));
    return changeIdChunks(id, matches.length === 1 ? matches[0]?.[1] : undefined, colors);
  };
  const lines = terminalText(text).split("\n");
  // A revision that moves in a pending rebase or squash is marked ● in preview trees; its row, both lines, takes the
  // accent so the moved changes stand out from the rest of the tree.
  let moving = false;
  return new StyledText(lines.flatMap((line, index) => {
    const graph = /^([│─┬┴├┤┼┌┐└┘╭╮╰╯╷╵╲╱\\/| @○◆●×~]*)\b([k-z]{8,})\b(.*)$/.exec(line);
    const revision = /^(Source |Squash from |Rebase from |Into |Change\s+)([k-z]+)(.*)$/.exec(line);
    const commit = /^(Commit\s+|Parents\s+)([0-9a-f ,]+)$/.exec(line);
    const bookmarks = /^(Bookmarks\s+)(.*)$/.exec(line);
    const chunks = [];
    const description = moving && !graph ? /^([│─┬┴├┤┼┌┐└┘╭╮╰╯╷╵╲╱\\/| ~]*)(.*)$/.exec(line) : null;
    moving = false;
    if (graph) {
      const prefix = graph[1] ?? "", tail = graph[3] ?? "";
      // Summary lines also start "● <change> / <commit>"; only tree rows carry their description on the next line.
      moving = prefix.includes("●") && !tail.startsWith(" / ");
      chunks.push(...graphChunks(prefix, colors).map(chunk => chunk.text === "●" ? bold(fg(colors.accent)("●")) : chunk), ...idChunks(graph[2] ?? ""));
      const conflict = tail.endsWith(" [conflict]");
      const body = conflict ? tail.slice(0, -11) : tail;
      const bookmarks = /^(?: \[[^\]]+\])*/.exec(body)?.[0] ?? "";
      if (bookmarks) chunks.push(fg(colors.bookmark)(bookmarks));
      chunks.push(fg(moving ? colors.accent : colors.text)(body.slice(bookmarks.length)));
      if (conflict) chunks.push(bold(fg(colors.conflict)(" [conflict]")));
    } else if (description) {
      chunks.push(fg(colors.text)(description[1] ?? ""), fg(colors.accent)(description[2] ?? ""));
    } else if (revision) {
      chunks.push(fg(colors.muted)(revision[1] ?? ""), ...idChunks(revision[2] ?? ""));
      const tail = revision[3] ?? "";
      const hash = /^( \/ )([0-9a-f]{12,40})(.*)$/.exec(tail);
      if (hash) chunks.push(fg(colors.muted)(hash[1] ?? ""), fg(colors.commit)(hash[2] ?? ""), fg(colors.text)(hash[3] ?? ""));
      else chunks.push(fg(colors.text)(tail));
    } else if (commit || bookmarks) {
      const match = commit ?? bookmarks;
      chunks.push(fg(colors.muted)(match?.[1] ?? ""), fg(commit ? colors.commit : colors.bookmark)(match?.[2] ?? ""));
    } else chunks.push(fg(colors.text)(line));
    if (index < lines.length - 1) chunks.push(fg(colors.text)("\n"));
    return chunks;
  }));
}
