import { StyledText, bold, fg } from "@opentui/core";
import { terminalText, type Revision } from "./repository";

export const jjColors = {
  text: "#d6e2eb", muted: "#91a6b7", workingCopy: "#6ed6bd", commit: "#7dcfff",
  changeId: "#c4a7e7", bookmark: "#e6c384", conflict: "#ffad9e",
};

export function graphChunks(prefix: string) {
  return [...terminalText(prefix)].map(mark => fg(
    mark === "@" ? jjColors.workingCopy : mark === "◆" ? jjColors.commit : jjColors.muted,
  )(mark));
}

export function revisionPrefixes(revisions: Pick<Revision, "changeId" | "changePrefix">[]) {
  return new Map(revisions.map(revision => [revision.changeId, revision.changePrefix]));
}

export function changeIdChunks(id: string, prefix?: string) {
  if (!prefix || !id.startsWith(prefix)) return [fg(jjColors.changeId)(id)];
  return [bold(fg(jjColors.changeId)(prefix)), fg(jjColors.muted)(id.slice(prefix.length))];
}

export function highlightJjText(text: string, prefixes: ReadonlyMap<string, string> = new Map()): StyledText {
  const idChunks = (id: string) => {
    const matches = [...prefixes].filter(([fullId]) => fullId.startsWith(id));
    return changeIdChunks(id, matches.length === 1 ? matches[0]?.[1] : undefined);
  };
  const lines = terminalText(text).split("\n");
  return new StyledText(lines.flatMap((line, index) => {
    const graph = /^([│─┬┴├┤┼┌┐└┘╭╮╰╯╷╵╲╱\\/| @○◆●×~]*)\b([k-z]{8,})\b(.*)$/.exec(line);
    const revision = /^(Source |Squash from |Rebase from |Into |Change\s+)([k-z]+)(.*)$/.exec(line);
    const commit = /^(Commit\s+|Parents\s+)([0-9a-f ,]+)$/.exec(line);
    const bookmarks = /^(Bookmarks\s+)(.*)$/.exec(line);
    const chunks = [];
    if (graph) {
      chunks.push(...graphChunks(graph[1] ?? ""), ...idChunks(graph[2] ?? ""));
      const tail = graph[3] ?? "";
      const conflict = tail.endsWith(" [conflict]");
      const body = conflict ? tail.slice(0, -11) : tail;
      const bookmarks = /^(?: \[[^\]]+\])*/.exec(body)?.[0] ?? "";
      if (bookmarks) chunks.push(fg(jjColors.bookmark)(bookmarks));
      chunks.push(fg(jjColors.text)(body.slice(bookmarks.length)));
      if (conflict) chunks.push(bold(fg(jjColors.conflict)(" [conflict]")));
    } else if (revision) {
      chunks.push(fg(jjColors.muted)(revision[1] ?? ""), ...idChunks(revision[2] ?? ""));
      const tail = revision[3] ?? "";
      const hash = /^( \/ )([0-9a-f]{12,40})(.*)$/.exec(tail);
      if (hash) chunks.push(fg(jjColors.muted)(hash[1] ?? ""), fg(jjColors.commit)(hash[2] ?? ""), fg(jjColors.text)(hash[3] ?? ""));
      else chunks.push(fg(jjColors.text)(tail));
    } else if (commit || bookmarks) {
      const match = commit ?? bookmarks;
      chunks.push(fg(jjColors.muted)(match?.[1] ?? ""), fg(commit ? jjColors.commit : jjColors.bookmark)(match?.[2] ?? ""));
    } else chunks.push(fg(jjColors.text)(line));
    if (index < lines.length - 1) chunks.push(fg(jjColors.text)("\n"));
    return chunks;
  }));
}
