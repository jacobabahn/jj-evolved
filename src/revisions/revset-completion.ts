import type { Bookmark, RevsetAlias } from "../repository/model";

// Deliberately a token completer, not a revset parser. Keep this list to jj's
// built-in functions (verified with `jj help -k revsets` in jj 0.45.1).
const functions: [signature: string, summary: string][] = [
  ["all()", "all visible commits"], ["none()", "no commits"], ["root()", "the virtual root commit"],
  ["visible_heads()", "all visible heads"], ["working_copies()", "working copies in all workspaces"],
  ["mine()", "commits authored by you"], ["merges()", "merge commits"], ["forks()", "commits with several children"],
  ["empty()", "commits modifying no files"], ["conflicts()", "commits with conflicted files"],
  ["divergent()", "divergent changes"], ["signed()", "signed commits"],
  ["parents(x, [depth])", "same as x-"], ["children(x, [depth])", "same as x+"],
  ["ancestors(x, [depth])", "same as ::x"], ["descendants(x, [depth])", "same as x::"],
  ["first_parent(x, [depth])", "first parents only"], ["first_ancestors(x, [depth])", "ancestors via first parents"],
  ["reachable(srcs, domain)", "reachable from srcs within domain"], ["connected(x)", "same as x::x"],
  ["heads(x)", "commits in x without descendants in x"], ["roots(x)", "commits in x without ancestors in x"],
  ["latest(x, [count])", "latest commits in x"], ["fork_point(x)", "common ancestor of x"],
  ["merge_point(x)", "common descendant of x"], ["bisect(x)", "midpoint candidates in x"],
  ["exactly(x, count)", "x, failing unless it has count commits"], ["present(x)", "x, or none() if it is missing"],
  ["coalesce(revsets...)", "first non-empty revset"], ["at_operation(op, x)", "x evaluated at an operation"],
  ["change_id(prefix)", "commits with a change ID prefix"], ["commit_id(prefix)", "commits with a commit ID prefix"],
  ["bookmarks([pattern])", "local bookmark targets"], ["remote_bookmarks([name_pattern], [[remote=]remote_pattern])", "remote bookmark targets"],
  ["tracked_remote_bookmarks([name_pattern], [[remote=]remote_pattern])", "tracked remote bookmarks"],
  ["untracked_remote_bookmarks([name_pattern], [[remote=]remote_pattern])", "untracked remote bookmarks"],
  ["tags([pattern])", "tag targets"], ["remote_tags([name_pattern], [[remote=]remote_pattern])", "remote tag targets"],
  ["description(pattern)", "description matches"], ["subject(pattern)", "first line matches"],
  ["author(pattern)", "author name or email matches"], ["author_name(pattern)", "author name matches"],
  ["author_email(pattern)", "author email matches"], ["author_date(pattern)", "author date matches"],
  ["committer(pattern)", "committer name or email matches"], ["committer_date(pattern)", "committer date matches"],
  ["files(expression)", "commits modifying matching paths"], ["diff_lines(text, [files])", "diff lines match"],
];
export type CompletionKind = "history" | "function" | "alias" | "bookmark" | "tag";
export type Completion = {
  kind: CompletionKind; label: string; detail: string; text: string; start: number; end: number;
  /** Offset of the cursor within `text` after applying; defaults to its end. */
  caret?: number;
};
export type RevsetSymbols = { bookmarks?: readonly Bookmark[]; tags?: readonly string[]; aliases?: readonly RevsetAlias[] };
type Candidate = Omit<Completion, "start" | "end">;
const boundary = /[\s():,|&~+*=<>]/;
function quote(name: string): string {
  // Quoting each side of @ preserves remote-symbol syntax. Conservative quoting
  // also avoids trailing '-' (parents) and '/' (change-offset) ambiguity.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
}
/** A function or function alias: arguments go between inserted parentheses; an existing call keeps its own. */
function callable(kind: CompletionKind, signature: string, detail: string, existingCall: boolean): Candidate {
  const name = signature.slice(0, signature.indexOf("("));
  if (existingCall) return { kind, label: signature, detail, text: name };
  const takesArguments = !signature.endsWith("()");
  return { kind, label: signature, detail, text: `${name}()`, caret: takesArguments ? name.length + 1 : undefined };
}

export function revsetCompletions(value: string, cursor: number, symbols: RevsetSymbols): Completion[] {
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
  const candidates: Candidate[] = (symbols.bookmarks ?? []).map(bookmark => ({
    kind: "bookmark",
    label: bookmark.name + (bookmark.remote ? `@${bookmark.remote}` : ""),
    detail: bookmark.remote ? "remote bookmark" : "bookmark",
    text: quote(bookmark.name) + (bookmark.remote ? `@${quote(bookmark.remote)}` : ""),
  }));
  candidates.push(...(symbols.tags ?? []).map(name => ({ kind: "tag" as const, label: name, detail: "tag", text: quote(name) })));
  if (!prefix.includes('"') && !prefix.includes("'") && !prefix.includes("@")) {
    const existingCall = value[end] === "(";
    for (const alias of symbols.aliases ?? []) {
      const detail = `alias: ${alias.definition.replace(/\s+/g, " ").trim()}`;
      candidates.push(alias.name.includes("(") ? callable("alias", alias.name, detail, existingCall) : { kind: "alias", label: alias.name, detail, text: alias.name });
    }
    candidates.push(...functions.map(([signature, summary]) => callable("function", signature, summary, existingCall)));
  }
  return candidates.filter(item => item.label.startsWith(rawPrefix) || item.text.startsWith(prefix))
    .filter((item, index, items) => items.findIndex(other => other.text === item.text) === index)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(item => ({ ...item, start, end }));
}

/**
 * Previously applied expressions that extend the whole input, most recent first. They replace the entire
 * input. An untouched input lists all of them, so reopening the prompt offers recent filters immediately.
 * The expression already in the input is never suggested.
 */
export function historyCompletions(value: string, history: readonly string[], untouched: boolean): Completion[] {
  const typed = value.trim();
  return history.filter(entry => entry !== typed && (untouched || entry.startsWith(typed)))
    .map(entry => ({ kind: "history", label: entry, detail: "recent", text: entry, start: 0, end: value.length }));
}

/**
 * Local bookmark names for the set-bookmark prompt, replacing the whole input. Names starting with the input come
 * first, then names containing it; the detail says whether choosing one moves it or leaves it on `commitId`.
 */
export function bookmarkNameCompletions(value: string, bookmarks: readonly Bookmark[], commitId: string): Completion[] {
  const typed = value.trim().toLowerCase();
  const local = bookmarks.filter(item => !item.remote && item.targets.length && item.name.toLowerCase().includes(typed));
  const rank = (name: string) => name.toLowerCase().startsWith(typed) ? 0 : 1;
  return local.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .filter(item => item.name !== value.trim())
    .map(item => ({
      kind: "bookmark", label: item.name, text: item.name, start: 0, end: value.length,
      detail: item.targets.includes(commitId) ? "already here" : `move from ${item.targets.map(id => id.slice(0, 8)).join(", ")}`,
    }));
}

export function applyCompletion(value: string, item: Completion) {
  return { value: value.slice(0, item.start) + item.text + value.slice(item.end), cursor: item.start + (item.caret ?? item.text.length) };
}
