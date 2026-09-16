import type { Bookmark } from "../repository/model";

// Deliberately a token completer, not a revset parser. Keep this list to jj's
// built-in functions (verified with `jj help -k revsets` in jj 0.45.1).
const functions = [
  "all()", "none()", "root()", "bookmarks()", "remote_bookmarks()", "tags()",
  "conflicts()", "empty()", "heads()", "roots()", "visible_heads()",
  "parents(@)", "children(@)", "ancestors(@)", "descendants(@)",
];
export type Completion = { label: string; text: string; start: number; end: number };
const boundary = /[\s():,|&~+*=<>]/;
function quote(name: string): string {
  // Quoting each side of @ preserves remote-symbol syntax. Conservative quoting
  // also avoids trailing '-' (parents) and '/' (change-offset) ambiguity.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
}

export function revsetCompletions(value: string, cursor: number, bookmarks: readonly Bookmark[]): Completion[] {
  cursor = Math.max(0, Math.min(value.length, cursor));
  const isBoundary = (index: number) => boundary.test(value[index]!) || (value[index] === "." && (value[index - 1] === "." || value[index + 1] === "."));
  let start = 0;
  let end = 0;
  // Quoted strings and remote symbols are one token, including escaped quotes.
  for (let i = 0; i < value.length;) {
    if (isBoundary(i)) { i++; continue; }
    const from = i;
    let quoteChar = "";
    while (i < value.length) {
      const char = value[i]!;
      if (quoteChar) {
        if (char === "\\" && quoteChar === '"') { i += 2; continue; }
        if (char === quoteChar) quoteChar = "";
      } else if (char === '"' || char === "'") quoteChar = char;
      else if (isBoundary(i)) break;
      i++;
    }
    if (from <= cursor && cursor <= i) { start = from; end = i; break; }
  }
  if (end === 0) start = end = cursor;
  const prefix = value.slice(start, cursor);
  // Decode even an unfinished quoted component for prefix matching. An inserted
  // candidate is always re-serialized using valid jj symbol quoting.
  const rawPrefix = prefix.replace(/"((?:\\.|[^"\\])*)"?|'([^']*)'?/g, (_match, double, single) => {
    if (single !== undefined) return single;
    try { return JSON.parse(`"${double}"`); } catch { return double; }
  });
  const candidates = bookmarks.flatMap(bookmark => {
    const raw = bookmark.name + (bookmark.remote ? `@${bookmark.remote}` : "");
    const text = quote(bookmark.name) + (bookmark.remote ? `@${quote(bookmark.remote)}` : "");
    return [{ label: raw, text }];
  });
  if (!prefix.includes('"') && !prefix.includes("'") && !prefix.includes("@")) {
    candidates.push(...functions.map(text => ({ label: text, text: value[end] === "(" ? text.slice(0, text.indexOf("(")) : text })));
  }
  return candidates.filter(item => item.label.startsWith(rawPrefix) || item.text.startsWith(prefix))
    .filter((item, index, items) => items.findIndex(other => other.text === item.text) === index)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(item => ({ ...item, start, end }));
}

export function applyCompletion(value: string, item: Completion) {
  return { value: value.slice(0, item.start) + item.text + value.slice(item.end), cursor: item.start + item.text.length };
}
