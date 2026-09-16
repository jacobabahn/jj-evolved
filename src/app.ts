import { MutationReview } from "./history/mutation-review";
import { PreviewSession } from "./preview/preview-session";
import { getTheme, setTheme, themes, themeNames, themeLabels, type ThemeName, type Theme } from "./ui/theme";
import { highlightJjText, revisionPrefixes } from "./ui/jj-highlighting";
import { ChangePreview } from "./preview/change-preview";
import {
  BorderChars, BoxRenderable, InputRenderable, ScrollBoxRenderable, SelectRenderable,
  TextRenderable, type CliRenderer, type KeyEvent,
} from "@opentui/core";
import { TreeComparisonView } from "./history/tree-comparison";
import { ActionOverlay } from "./ui/action-overlay";
import { HistoryForm } from "./history/history-form";
import { RevisionLog } from "./revisions/revision-log";
import { Repository } from "./repository/repository";
import { terminalText } from "./terminal-text";
import { shortChangeId, type InteractiveAction, type Mutation, type Revision, type Snapshot, type Bookmark } from "./repository/model";

type Choice = { name: string; description: string; choose: () => void; preview?: () => Promise<string> };

type Prompt =
  | { kind: "browse" }
  | { kind: "theme"; original: Theme }
  | { kind: "inline"; source: Revision; action: { kind: "rebase"; descendants: boolean; scope: Revision[] } | { kind: "squash" } }
  | { kind: "form"; form: HistoryForm }
  | { kind: "search"; view: NavigationView; previous: Search; returnPoint: NavigationView | null }
  | { kind: "revset" }
  | { kind: "describe"; revision: Revision }
  | { kind: "new"; parent: Revision }
  | { kind: "picker"; choices: Choice[] }
  | { kind: "text"; accept: (value: string) => void }
  | { kind: "confirm"; action: Mutation; edit: (() => void) | null; back: (() => void) | null };

type Search = { query: string; matches: Revision[] };
type NavigationView = { snapshot: Snapshot; bookmarks: Bookmark[]; index: number; top: number; outside: ReadonlySet<string> };

const HELP = `Keyboard reference

j / k or arrows   Move through revisions
Tab               Switch revisions / preview focus
Page Up / Down    Scroll preview
s                 Working-copy status
r                 Refresh history
/                 Enter a revset; empty restores all()
Ctrl-F            Search descriptions, bookmarks and ID prefixes in revset
Ctrl-N / Ctrl-P   Next / previous search match, wrapping
@ / [ / ]         Jump to working copy / parent / child
Ctrl-O            Return from temporary reveal
Escape            Clear accepted search
* / +             Search match / revision outside active revset
d                 Describe selected change, single line
e                 Make selection the working copy immediately
R / S             Choose rebase / squash destination in the graph
a                 Preview absorb into mutable ancestors
v                 Browse selected change's evolution
Drag change       Drop onto another change to preview rebase
n                 Create an empty child of selection
Space             Action menu: edit, rebase, squash, split, abandon
b                 Local and remote bookmarks
o                 Operation history, inspection and restore
u                 Preview undo of the latest operation
f                 Browse files changed in selected revision
Enter             Return to the selected revision preview
t                 Choose a theme, preview and save
?                 Show this help
q / Ctrl-C        Quit

In prompts
Enter             Apply / confirm
Escape            Cancel

@ marks the working copy. ! marks a conflict.
Drag a local [bookmark] onto another change to preview a move.
Escape or dropping outside the graph cancels. Remote bookmarks are read-only.
Tree lines show ancestry; ~ marks omitted history.
History shows at most 200 revisions.
Select a revision to return from status or help.
Commands use your installed jj and its repository rules.`;

export function createApp(renderer: CliRenderer, repository: Repository, theme: Theme = themes.terminal, saveTheme: (name: ThemeName) => Promise<void> = async () => {}) {
  setTheme(renderer, theme);
  let colors = getTheme(renderer);
  const app = new BoxRenderable(renderer, { id: "app", width: "100%", height: "100%", flexDirection: "column", backgroundColor: colors.bg });
  const header = new TextRenderable(renderer, { id: "header", height: 1, fg: colors.accent, content: terminalText(`jj-evolved  /  ${repository.root}`) });
  const filter = new TextRenderable(renderer, { id: "revset", height: 1, fg: colors.muted, content: "revset: all()" });
  const body = new BoxRenderable(renderer, { id: "body", flexDirection: "row", flexGrow: 1, minHeight: 1 });
  const listBox = new BoxRenderable(renderer, { id: "revision-pane", width: "42%", minWidth: 26, flexShrink: 0, border: true, customBorderChars: { ...BorderChars.single, topRight: "┬", bottomRight: "┴" }, borderColor: colors.accent, title: " Revisions ", backgroundColor: colors.panel });
  const list = new RevisionLog(renderer);
  list.height = 0;
  list.flexGrow = 1;
  const preview = new ScrollBoxRenderable(renderer, { id: "preview", flexGrow: 1, width: 0, minWidth: 1, border: ["top", "right", "bottom"], borderColor: colors.border, title: " Change preview ", scrollY: true, scrollX: true, contentOptions: { width: "100%", minHeight: 0 } });
  const detail = new ChangePreview(renderer, "preview-text", "Loading repository…");
  const promptLabel = new TextRenderable(renderer, { id: "prompt-label", height: 1, visible: false, fg: colors.accent });
  const input = new InputRenderable(renderer, { id: "prompt-input", visible: false, width: "100%", textColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.panel, focusedTextColor: colors.text, placeholderColor: colors.muted });
  const searchInput = new InputRenderable(renderer, { id: "search-input", visible: false, width: "100%", placeholder: "Search active revset", textColor: colors.text, focusedTextColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.panel });
  const searchStatus = new TextRenderable(renderer, { id: "search-status", visible: false, height: 1, wrapMode: "none", truncate: true, fg: colors.accent });
  const navigationStatus = new TextRenderable(renderer, { id: "navigation-status", visible: false, height: 1, fg: colors.accent, content: "temporary view (up to 40) | + outside filter | ^O return" });
  const message = new TextRenderable(renderer, { id: "message", height: 1, fg: colors.muted, content: "Loading history…" });
  const inlineHint = new TextRenderable(renderer, { id: "inline-action", height: 3, flexShrink: 0, visible: false, fg: colors.accent });
  const shortcuts = new TextRenderable(renderer, { id: "shortcuts", height: 2, fg: colors.accent, content: "j/k move  / filter  ^F search  ^N/^P match  @ work  [/] ancestry\n^O return  Esc clear  Space actions  r refresh  ? help  q quit" });
  const chooser = new SelectRenderable(renderer, { id: "action-choices", visible: false, width: "100%", height: "45%", minHeight: 2, options: [], backgroundColor: colors.panel, focusedBackgroundColor: colors.panel, textColor: colors.text, focusedTextColor: colors.text, selectedBackgroundColor: colors.selected, selectedTextColor: colors.selectedText, descriptionColor: colors.muted, showDescription: true, itemSpacing: 0, wrapSelection: false, selectedDescriptionColor: colors.selectedText });
  const overlay = new ActionOverlay(renderer, "action-overlay");
  overlay.visible = false;
  const overlayPreview = new ScrollBoxRenderable(renderer, { id: "overlay-preview", flexGrow: 1, minHeight: 1, contentOptions: { width: "100%", minHeight: 0 }, border: true, borderColor: colors.border, title: " Preview " });
  const overlayText = new ChangePreview(renderer, "overlay-preview-text");
  const comparison = new TreeComparisonView(renderer, "confirmation-trees");
  overlayPreview.add(comparison);
  overlayPreview.add(overlayText);
  overlay.fields.add(promptLabel);
  overlay.fields.add(input);
  overlay.body.add(chooser);
  overlay.body.add(overlayPreview);
  const result = new TextRenderable(renderer, { id: "action-result", height: 2, visible: false, fg: colors.accent });
  listBox.add(result);
  listBox.add(list);
  preview.add(detail);
  body.add(listBox);
  body.add(preview);
  for (const child of [header, filter, message, navigationStatus, searchInput, searchStatus, inlineHint, body, shortcuts, overlay]) app.add(child);
  renderer.root.add(app);

  let resultTimer: ReturnType<typeof setTimeout> | undefined;
  let revisions: Revision[] = [];
  let revset = "all()";
  let currentSnapshot: Snapshot = { root: repository.root, revisions: [], graph: [] };
  let currentBookmarks: Bookmark[] = [];
  let outsideFilter: ReadonlySet<string> = new Set();
  let returnPoint: NavigationView | null = null;
  let search: Search = { query: "", matches: [] };
  let searchCandidates: Revision[] = [];
  let searchBookmarks: Bookmark[] = [];
  let searchRequest = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let prompt: Prompt = { kind: "browse" };
  let busy = false;
  let stopped = false;
  let replacing = false;
  const review = new MutationReview(repository, refreshAfterMutation);
  const previews = new PreviewSession(({ target, text, title }) => {
    if (target === "overlay") {
      comparison.setTrees(null);
      overlayPreview.title = ` ${title} `;
      overlayText.content = text;
      overlayPreview.scrollTo(0);
    } else {
      preview.title = ` ${title} `;
      detail.content = text;
      preview.scrollTo(0);
    }
  });
  function isBusy() { return busy || review.applying; }
  let focus: "list" | "preview" = "list";

  function selected() { return revisions[list.getSelectedIndex()]; }
  function report(text: string, error = false) {
    if (stopped) return;
    if (overlay.visible) { message.content = ""; overlay.report(text, error); return; }
    message.fg = error ? colors.conflict : colors.muted;
    message.content = terminalText(text);
  }
  function setFocus(next: typeof focus) {
    focus = next;
    listBox.borderColor = next === "list" ? colors.accent : colors.border;
    preview.borderColor = next === "preview" ? colors.accent : colors.border;
    if (next === "list") list.focus(); else preview.focus();
  }
  function showOverlay(text: string, title: string) {
    previews.show({ target: "overlay", text, title });
  }
  function activateOverlay(title: string, cancelPreview = true) {
    if (cancelPreview) previews.cancel();
    if (!overlay.visible) {
      const revision = selected();
      overlay.context.content = revision ? highlightJjText(`Source ${shortChangeId(revision)} / ${revision.commitId.slice(0, 12)}\n${revision.description.split("\n")[0] || "(no description)"}`, revisionPrefixes([revision]), colors) : "Repository actions";
    }
    overlay.title = ` ${title} `;
    overlay.height = "84%";
    overlay.top = "8%";
    overlayPreview.visible = true;
    overlay.visible = true;
    message.content = "";
    list.mouseSelectionEnabled = false;
    overlay.report("");
    overlay.hints.content = "Enter apply/select  Esc cancel  PgUp/Dn preview";
    list.blur();
    preview.blur();
  }
  function show(text: string, title: string) {
    previews.show({ target: "main", text, title });
  }
  async function loadPreview() {
    const revision = selected();
    if (!revision) { show("No revisions match this revset. Press / to change it.", "No revisions"); return; }
    const metadata = terminalText(`${revision.description.trimEnd() || "(no description)"}\n\nChange   ${revision.changeId}\nCommit   ${revision.commitId}\nAuthor   ${revision.author}\nBookmarks ${revision.bookmarks || "none"}\nParents  ${revision.parents.map(id => id.slice(0, 12)).join(", ") || "none"}\n${revision.workingCopy ? "Working copy  " : ""}${revision.conflict ? "CONFLICT\nUse jj resolve in another terminal, then r to refresh." : ""}`.trimEnd() + "\n\n");
    await previews.load({ target: "main", title: "Change preview", loading: "Loading diff…",
      prefix: metadata, read: () => repository.diff(revision), empty: "Empty change. No file differences." });
  }
  function errorText(error: unknown) { return terminalText(error instanceof Error ? error.message : String(error)); }
  async function refresh(nextRevset = revset, workingCopy = false) {
    const previous = selected();
    list.cancelDrag();
    const snapshot = await repository.snapshot(nextRevset);
    const bookmarks = await repository.bookmarks();
    if (stopped) return;
    ++searchRequest;
    clearTimeout(searchTimer);
    search = { query: "", matches: [] };
    returnPoint = null;
    outsideFilter = new Set();
    currentSnapshot = snapshot;
    currentBookmarks = bookmarks;
    revisions = snapshot.revisions;
    updateSearchStatus();
    detail.prefixes = overlayText.prefixes = revisionPrefixes(revisions);
    revset = nextRevset;
    filter.content = terminalText(`revset: ${revset}  ·  ${revisions.length} revisions (limit 200)`);
    let index = workingCopy ? revisions.findIndex(item => item.workingCopy) : -1;
    if (index < 0 && previous) index = revisions.findIndex(item => item.commitId === previous.commitId);
    if (index < 0 && previous) {
      const matches = revisions.filter(item => item.changeId === previous.changeId);
      if (matches.length === 1) index = revisions.findIndex(item => item.changeId === previous.changeId);
    }
    replacing = true;
    list.setSnapshot(snapshot, bookmarks);
    if (revisions.length) list.setSelectedIndex(Math.max(0, index));
    replacing = false;
    await loadPreview();
  }
  function captureView(): NavigationView {
    return { snapshot: currentSnapshot, bookmarks: currentBookmarks, index: list.getSelectedIndex(), top: list.scrollTop, outside: outsideFilter };
  }
  function displayView(view: NavigationView) {
    currentSnapshot = view.snapshot;
    currentBookmarks = view.bookmarks;
    outsideFilter = view.outside;
    revisions = currentSnapshot.revisions;
    detail.prefixes = overlayText.prefixes = revisionPrefixes(revisions);
    replacing = true;
    list.setSnapshot(currentSnapshot, currentBookmarks);
    list.setSelectedIndex(view.index);
    list.scrollTop = view.top;
    replacing = false;
    filter.content = terminalText(`revset: ${revset}`);
    updateSearchStatus();
  }
  function updateSearchStatus() {
    navigationStatus.visible = returnPoint !== null;
    searchStatus.visible = search.query.length > 0 || prompt.kind === "search";
    const index = search.matches.findIndex(item => item.commitId === selected()?.commitId);
    const position = search.matches.length ? (index < 0 ? `${search.matches.length} matches` : `${index + 1}/${search.matches.length}`) : search.query ? "No matches" : "Type to search";
    const hints = prompt.kind === "search" ? "Enter keep  Esc cancel" : "^N/^P next/prev";
    searchStatus.content = terminalText(`Search in revset: ${position} | ${hints} | ${search.query}`);
    list.markNavigation(new Set(search.matches.map(item => item.commitId)), outsideFilter);
  }
  async function navigate(target: Revision, request?: number) {
    let index = revisions.findIndex(item => item.commitId === target.commitId);
    if (index < 0) {
      const context = `${target.commitId} | latest(parents(${target.commitId}) | children(${target.commitId}), 39)`;
      const [snapshot, included, bookmarks] = await Promise.all([
        repository.snapshot(context, true), repository.navigationRevisions(`(${context}) & (${revset})`), repository.bookmarks(),
      ]);
      if (stopped || (request !== undefined && request !== searchRequest)) return;
      index = snapshot.revisions.findIndex(item => item.commitId === target.commitId);
      if (index < 0) throw new Error("Target no longer exists. Refresh history.");
      returnPoint ??= captureView();
      const ids = new Set(included.map(item => item.commitId));
      displayView({ snapshot, bookmarks, index, top: 0, outside: new Set(snapshot.revisions.filter(item => !ids.has(item.commitId)).map(item => item.commitId)) });
    }
    replacing = true;
    list.setSelectedIndex(index);
    replacing = false;
    updateSearchStatus();
    await loadPreview();
  }
  async function updateSearch() {
    const request = ++searchRequest;
    const query = searchInput.value;
    const needle = query.toLowerCase();
    const bookmarkIds = new Set(searchBookmarks.filter(item => `${item.name}${item.remote ? `@${item.remote}` : ""}`.toLowerCase().includes(needle)).flatMap(item => item.targets));
    search = { query, matches: query ? searchCandidates.filter(item => item.description.toLowerCase().includes(needle) || item.changeId.startsWith(needle) || item.commitId.startsWith(needle) || bookmarkIds.has(item.commitId)) : [] };
    updateSearchStatus();
    const first = search.matches[0];
    if (first) await navigate(first, request);
  }
  function queueSearch() {
    if (prompt.kind !== "search") return;
    ++searchRequest;
    clearTimeout(searchTimer);
    searchStatus.content = "Searching active revset…";
    searchTimer = setTimeout(() => {
      void updateSearch().catch(error => report(errorText(error), true));
    }, 100);
  }
  function beginSearch() {
    void run("Loading search scope…", async () => {
      const [candidates, bookmarks] = await Promise.all([repository.navigationRevisions(revset), repository.bookmarks()]);
      if (stopped) return;
      searchCandidates = candidates;
      searchBookmarks = bookmarks;
      prompt = { kind: "search", view: captureView(), previous: search, returnPoint };
      searchInput.value = search.query;
      searchInput.visible = true;
      list.mouseSelectionEnabled = false;
      list.blur(); preview.blur(); searchInput.focus();
      updateSearchStatus();
    });
  }
  async function finishSearch(cancel: boolean) {
    const state = prompt;
    if (state.kind !== "search") return;
    clearTimeout(searchTimer);
    ++searchRequest;
    if (cancel) {
      search = state.previous;
      returnPoint = state.returnPoint;
      displayView(state.view);
    } else {
      await updateSearch();
      if (stopped || prompt !== state) return;
    }
    searchInput.blur(); searchInput.visible = false;
    closePrompt();
    updateSearchStatus();
    await loadPreview();
  }
  function nextMatch(direction: number) {
    void run("Finding match…", async () => {
      const index = search.matches.findIndex(item => item.commitId === selected()?.commitId);
      const next = index < 0 ? (direction > 0 ? 0 : search.matches.length - 1) : (index + direction + search.matches.length) % search.matches.length;
      const target = search.matches[next];
      if (target) await navigate(target);
    });
  }
  function jump(direction: "parent" | "child" | "working copy") {
    const source = selected();
    if (!source && direction !== "working copy") { report(`No ${direction}.`); return; }
    void run("Finding revision…", async () => {
      const expression = direction === "working copy" ? "@" : `${direction === "parent" ? "parents" : "children"}(${source?.commitId})`;
      const [targets, included] = await Promise.all([repository.navigationRevisions(expression), repository.navigationRevisions(`(${expression}) & (${revset})`)]);
      if (stopped) return;
      const target = targets[0];
      if (!target) { show(`No ${direction}.`, "Navigation"); return; }
      if (targets.length === 1) { await navigate(target); return; }
      const ids = new Set(included.map(item => item.commitId));
      pick(`Choose ${direction}`, targets.map(item => ({
        name: `${shortChangeId(item)} ${item.description.split("\n")[0] || "(no description)"}`,
        description: `${item.commitId.slice(0, 12)} ${ids.has(item.commitId) ? "" : "+ outside filter"}`,
        preview: async () => `${item.description}\n\n${await repository.diff(item)}`,
        choose: () => { closePrompt(); void run("Navigating…", () => navigate(item)); },
      })));
    });
  }
  async function run(label: string, action: () => Promise<void>) {
    if (isBusy() || stopped) return;
    busy = true;
    report(label);
    try { await action(); report("Ready. ? shows all controls."); }
    catch (error) {
      if (prompt.kind === "confirm" && prompt.edit) prompt.edit();
      report(errorText(error), true);
    }
    finally { busy = false; }
  }
  function closePrompt() {
    if (prompt.kind === "form") prompt.form.dispose();
    prompt = { kind: "browse" };
    review.cancel();
    previews.cancel();
    overlay.visible = false;
    inlineHint.visible = false;
    list.markSource(null);
    list.mouseSelectionEnabled = true;
    input.blur();
    chooser.blur();
    chooser.visible = false;
    list.visible = true;
    listBox.title = " Revisions ";
    input.visible = false;
    promptLabel.visible = false;
    setFocus(focus);
  }
  function openPrompt(next: Exclude<Prompt, { kind: "browse" }>, label: string, value = "") {
    activateOverlay(label);
    chooser.visible = false;
    prompt = next;
    if (next.kind === "describe" || next.kind === "revset" || next.kind === "text") {
      overlay.height = 12;
      overlay.top = "20%";
      overlayPreview.visible = false;
    }
    if (next.kind === "describe" || next.kind === "new" || next.kind === "revset" || next.kind === "text") showOverlay(label, "Action");
    promptLabel.content = terminalText(`${label}  [Enter apply · Esc cancel]`);
    promptLabel.visible = true;
    input.value = terminalText(value);
    input.visible = next.kind !== "new" && next.kind !== "confirm";
    if (!input.visible) { list.blur(); preview.blur(); } else input.focus();
    if (next.kind === "confirm") overlay.hints.content = "Enter apply  p refresh preview  Esc cancel  PgUp/Dn scroll";
  }
  async function submit() {
    if (isBusy()) return;
    const current = prompt;
    const value = input.value;
    if (current.kind === "text") { current.accept(value); return; }
    if (current.kind === "confirm") { await run("Applying jj operation…", applyReviewed); return; }
    if (current.kind === "revset") await run("Loading revset…", async () => { await refresh(value.trim() || "all()"); closePrompt(); });
    else if (current.kind === "describe" || current.kind === "new") {
      const mutation: Mutation = current.kind === "new" ? { kind: "new", parent: current.parent } : { kind: "describe", revision: current.revision, description: value };
      await run("Applying jj operation…", async () => {
        if (await review.prepare(mutation)) await applyReviewed();
      });
    }
  }
  async function refreshAfterMutation(action: Mutation) {
    if (stopped) return;
    const followWorkingCopy = ["new", "edit", "restore", "undo", "split"].includes(action.kind);
    await refresh(followWorkingCopy ? "all()" : revset, followWorkingCopy);
    if (stopped) return;
    const target = action.kind === "squash" ? action.destination : "revision" in action ? action.revision : null;
    if (!followWorkingCopy && target) {
      let index = revisions.findIndex(revision => revision.changeId === target.changeId);
      if (index < 0 && action.kind === "absorb") {
        await refresh("all()");
        if (stopped) return;
        index = revisions.findIndex(revision => revision.changeId === target.changeId);
        if (index < 0) index = revisions.findIndex(revision => revision.workingCopy);
      }
      if (index >= 0) { list.setSelectedIndex(index); await loadPreview(); }
    }
  }
  async function applyReviewed() {
    const outcome = await review.apply();
    if (outcome.kind === "not-ready") throw new Error("Review the action again before applying. Press p to refresh the preview.");
    if (outcome.kind !== "applied" || stopped) return;
    closePrompt();
    if (outcome.refreshError) throw new Error(outcome.refreshError);
    result.content = `${outcome.action.kind.replace("bookmark-", "Bookmark ")} completed\n${selected()?.changeId.slice(0, 8) || "Repository updated"}`;
    result.visible = true;
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => { if (!stopped) result.visible = false; }, 4000);
  }
  function confirm(action: Mutation) {
    const previous = prompt;
    const value = input.value;
    const label = String(overlay.title || "Edit action").trim();
    const back = previous.kind === "inline" ? () => resumeInline(previous) : previous.kind === "confirm" ? previous.back : null;
    const edit = back || (previous.kind === "text" ? () => openPrompt(previous, label, value) : previous.kind === "confirm" ? previous.edit : null);
    void run("Preparing operation preview…", async () => {
      const prepared = await review.prepare(action);
      if (!prepared) return;
      showOverlay(prepared.summary, "Confirm operation");
      comparison.setTrees(prepared.trees, action.kind === "rebase" || action.kind === "squash" ? action.kind : undefined);
      openPrompt({ kind: "confirm", action, edit, back }, "Review preview before applying");
      if (back) {
        inlineHint.visible = false;
        if (action.kind === "rebase" || action.kind === "squash") {
          const context = action.kind === "rebase" && action.descendants
            ? "● source and descendants will rebase; scroll for full list"
            : action.revision.description.split("\n")[0] || "(no description)";
          overlay.context.content = highlightJjText(`Source ${shortChangeId(action.revision)} / ${action.revision.commitId.slice(0, 12)}\n${context}`, revisionPrefixes([action.revision]), colors);
        }
        overlay.hints.content = "Enter apply  Esc choose destination  p refresh preview  PgUp/Dn scroll";
      }
    });
  }
  function ask(label: string, value: string, accept: (value: string) => void) {
    openPrompt({ kind: "text", accept }, label, value);
  }
  function applyTheme(theme: Theme) {
    colors = theme;
    setTheme(renderer, theme);
    app.backgroundColor = colors.bg;
    header.fg = navigationStatus.fg = searchStatus.fg = promptLabel.fg = inlineHint.fg = shortcuts.fg = result.fg = colors.accent;
    filter.fg = message.fg = colors.muted;
    listBox.backgroundColor = colors.panel;
    listBox.borderColor = focus === "list" ? colors.accent : colors.border;
    preview.borderColor = focus === "preview" ? colors.accent : colors.border;
    overlayPreview.borderColor = colors.border;
    input.backgroundColor = input.focusedBackgroundColor = colors.panel;
    input.textColor = input.focusedTextColor = colors.text;
    input.placeholderColor = colors.muted;
    searchInput.backgroundColor = searchInput.focusedBackgroundColor = colors.panel;
    searchInput.textColor = searchInput.focusedTextColor = colors.text;
    searchInput.placeholderColor = colors.muted;
    chooser.backgroundColor = chooser.focusedBackgroundColor = colors.panel;
    chooser.textColor = chooser.focusedTextColor = colors.text;
    chooser.descriptionColor = colors.muted;
    chooser.selectedBackgroundColor = colors.selected;
    chooser.selectedTextColor = chooser.selectedDescriptionColor = colors.selectedText;
    list.applyTheme();
    detail.applyTheme();
    overlay.applyTheme();
    overlayText.applyTheme();
    comparison.applyTheme();
  }

  function previewTheme() {
    const name = themeNames[chooser.getSelectedIndex()];
    if (!name) return;
    applyTheme(themes[name]);
    overlay.context.content = `Previewing ${themeLabels[name]}`;
    showOverlay(`diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1 +1 @@
-export const greeting = "Hello";
+export const greeting = "Hello, Jujutsu!";
`, "Theme preview");
  }

  function pickTheme() {
    const original = colors;
    activateOverlay("Theme", false);
    prompt = { kind: "theme", original };
    input.blur();
    input.visible = promptLabel.visible = false;
    chooser.visible = true;
    chooser.showDescription = false;
    chooser.options = themeNames.map(name => ({
      name: `${themeLabels[name]}${themes[name] === original ? "  (current)" : ""}`,
      description: "",
    }));
    chooser.setSelectedIndex(Math.max(0, themeNames.findIndex(name => themes[name] === original)));
    chooser.focus();
    overlay.hints.content = "j/k preview  Enter save  Esc restore";
    previewTheme();
  }

  async function keepTheme() {
    const name = themeNames[chooser.getSelectedIndex()];
    if (!name || isBusy()) return;
    busy = true;
    try {
      await saveTheme(name);
      if (stopped) return;
      closePrompt();
      report(`Theme: ${themeLabels[name]}`);
    } catch (error) {
      if (!stopped) overlay.report(`Could not save theme: ${errorText(error)}`, true);
    } finally {
      busy = false;
    }
  }

  function previewChoice() {
    if (prompt.kind === "theme") { previewTheme(); return; }
    if (prompt.kind !== "picker") return;
    const choice = prompt.choices[chooser.getSelectedIndex()];
    if (!choice) { previews.cancel(); return; }
    if (choice.preview) void previews.load({ target: "overlay", title: "Selection preview",
      loading: `${choice.name}\n\n${choice.description}`, read: choice.preview });
    else showOverlay(`${choice.name}\n\n${choice.description}`, "Selection");
  }
  function pick(title: string, choices: Choice[]) {
    activateOverlay(title);
    input.blur();
    input.visible = false;
    promptLabel.visible = false;
    prompt = { kind: "picker", choices };
    chooser.visible = true;
    chooser.showDescription = true;
    chooser.options = choices.map(choice => ({ name: terminalText(choice.name), description: terminalText(choice.description) }));
    chooser.setSelectedIndex(0);
    chooser.focus();
    overlay.hints.content = "j/k choose  Enter select  Esc cancel  PgUp/Dn preview";
    previewChoice();
  }
  function destination(title: string, source: Revision | null, accept: (revision: Revision) => void) {
    void run("Loading destinations…", async () => {
      const snapshot = await repository.snapshot("all()");
      if (stopped) return;
      overlayText.prefixes = revisionPrefixes(snapshot.revisions);
      pick(title, snapshot.revisions.filter(item => item.commitId !== source?.commitId).map(item => ({
        name: `${item.changeId.slice(0, 8)} ${item.description.trim() || "(no description)"}`,
        description: `${item.commitId.slice(0, 12)} ${item.bookmarks}`,
        choose: () => accept(item), preview: () => repository.diff(item),
      })));
    });
  }
  function chooseFiles(revision: Revision, title: string, accept: (paths: string[]) => void) {
    void run("Loading changed files…", async () => {
      const files = await repository.files(revision);
      if (stopped) return;
      const chosen = new Set<string>();
      function renderFiles() {
        pick(title, [
          { name: `Continue with ${chosen.size} files`, description: "Enter to review the selected group", choose: () => {
            if (!chosen.size) { report("Select at least one file.", true); renderFiles(); return; }
            accept([...chosen]);
          } },
          ...files.map(file => ({ name: `${chosen.has(file.path) ? "[x]" : "[ ]"} ${file.path}`, description: file.status,
            choose: () => { const index = chooser.getSelectedIndex(); chosen.has(file.path) ? chosen.delete(file.path) : chosen.add(file.path); renderFiles(); chooser.setSelectedIndex(index); },
            preview: () => repository.diff(revision, [file.path]),
          })),
        ]);
      }
      renderFiles();
    });
  }
  function browseFiles(revision: Revision) {
    void run("Loading changed files…", async () => {
      const files = await repository.files(revision);
      if (stopped) return;
      pick("Changed files", files.map(file => ({ name: file.path, description: file.status,
        preview: () => repository.diff(revision, [file.path]),
        choose: () => { void previews.load({ target: "overlay", title: "Change preview", loading: "Loading diff…", read: () => repository.diff(revision, [file.path]) }); },
      })));
      if (!files.length) showOverlay("Empty change. No changed files.", "Changed files");
    });
  }
  function showBookmarks() {
    void run("Loading bookmarks…", async () => {
      const bookmarks = await repository.bookmarks();
      if (stopped) return;
      pick("Bookmarks", bookmarks.map(bookmark => ({
        name: `${bookmark.name}${bookmark.remote ? `@${bookmark.remote}` : ""}${bookmark.conflict ? " !" : ""}`,
        description: `${bookmark.remote ? "Read-only remote" : "Local"} ${bookmark.targets.map(id => id.slice(0, 12)).join(", ") || "deleted"}`,
        choose: () => {
          if (bookmark.remote) { showOverlay(`Remote bookmark ${bookmark.name}@${bookmark.remote}\n\nTargets: ${bookmark.targets.join(", ")}\n\nRemote bookmarks are read-only.`, "Remote bookmark"); return; }
          pick(bookmark.name, [
            { name: "Move bookmark", description: "Choose a new target revision", choose: () => {
              destination("Bookmark target", null, revision => confirm({ kind: "bookmark-move", name: bookmark.name, revision }));
            } },
            { name: "Rename bookmark", description: "Keep its current targets", choose: () => ask("New bookmark name", bookmark.name, newName => confirm({ kind: "bookmark-rename", name: bookmark.name, newName })) },
            { name: "Delete bookmark", description: "Delete the local bookmark", choose: () => confirm({ kind: "bookmark-delete", name: bookmark.name }) },
          ]);
        },
      })));
      if (!bookmarks.length) showOverlay("No bookmarks. Select a revision and press Space to create one.", "Bookmarks");
    });
  }
  function showOperations(limit = 50) {
    void run("Loading operation history…", async () => {
      const operations = await repository.operations(limit);
      if (stopped) return;
      const choices: Choice[] = operations.map(operation => ({
        name: `${operation.current ? "@ " : ""}${operation.description}`,
        description: `${operation.id.slice(0, 12)} ${operation.time}`,
        preview: () => repository.operationDiff(operation),
        choose: () => pick("Operation actions", [
          { name: "Inspect operation", description: operation.id, choose: () => { void previews.load({ target: "overlay", title: "Operation details", loading: "Loading operation…", read: () => repository.operationDiff(operation) }); } },
          { name: "Restore this operation", description: "Restore repository state and local bookmarks", choose: () => confirm({ kind: "restore", operation }) },
        ]),
      }));
      if (operations.length === limit) choices.push({ name: "Load older operations", description: `Show up to ${limit + 50} operations`, choose: () => showOperations(limit + 50) });
      pick("Operation history", choices);
    });
  }
  function showEvolution(revision: Revision, limit = 50, operationId?: string, selectedIndex = 0) {
    void run("Loading change evolution…", async () => {
      const page = await repository.evolution(revision, { limit, operationId });
      if (stopped) return;
      const choices: Choice[] = page.entries.map(entry => ({
        name: `${entry.commitId === revision.commitId ? "Selected · " : ""}${entry.commitId.slice(0, 12)} ${entry.description.split("\n")[0] || "(no description)"}`,
        description: `${entry.operationDescription} · ${entry.time}`,
        preview: () => repository.evolutionDiff(page.operationId, entry),
        choose: () => previewChoice(),
      }));
      if (page.hasMore) choices.push({
        name: "Load older versions", description: `Show up to ${limit + 50} versions`,
        choose: () => showEvolution(revision, limit + 50, page.operationId, page.entries.length),
      });
      pick("Change evolution", choices);
      chooser.setSelectedIndex(selectedIndex);
      overlay.hints.content = "j/k version  Enter preview  Esc close  PgUp/Dn scroll";
      if (!page.entries.length) showOverlay("No evolution history is available for this revision.", "Change evolution");
    });
  }
  function undo() {
    void run("Loading latest operation…", async () => {
      const operation = (await repository.operations(1))[0];
      if (!operation) throw new Error("No operation to undo.");
      const action: Mutation = { kind: "undo", operation };
      const prepared = await review.prepare(action);
      if (!prepared) return;
      showOverlay(prepared.summary, "Confirm undo");
      openPrompt({ kind: "confirm", action, edit: null, back: null }, "Review undo before applying");
    });
  }
  function openHistory(revision: Revision, kind: "rebase" | "squash", descendants = false) {
    closePrompt();
    const form = new HistoryForm(renderer, repository, revision,
      kind === "rebase" ? { kind, descendants } : { kind, files: [], description: "", keepDescription: true },
      review, async () => {
        try { await applyReviewed(); report("Ready. ? shows all controls."); }
        catch (error) { if (prompt.kind === "browse") report(errorText(error), true); throw error; }
      }, moving => list.markSource(revisions.findIndex(item => item.commitId === revision.commitId), new Set(moving.map(item => item.commitId))));
    app.add(form);
    prompt = { kind: "form", form };
    message.content = "";
    list.mouseSelectionEnabled = false;
    list.blur();
    preview.blur();
  }
  function describe(revision: Revision) {
    if (revision.description.trimEnd().includes("\n")) report("This description has multiple lines. Choose Edit description in editor from the Space menu.", true);
    else openPrompt({ kind: "describe", revision }, `Describe ${revision.changeId.slice(0, 8)}`, revision.description.trimEnd());
  }
  function editInteractively(action: InteractiveAction) {
    openExternal(`JJ's diff editor for ${action.kind}`, () => repository.interactive(action));
  }
  function openExternal(name: string, launch: () => Promise<void>, preserveSelection = false) {
    void run(`Opening ${name}…`, async () => {
      closePrompt();
      try {
        renderer.suspend();
        await launch();
      } finally {
        renderer.resume();
        await refresh(preserveSelection ? revset : "all()", !preserveSelection).catch(error => {
          throw new Error(`Refreshing after ${name} failed. Press r to reload before repeating the action. ${errorText(error)}`);
        });
      }
    });
  }

  function actions(revision: Revision) {
    pick("Actions", [
      { name: "Edit change", description: "Make selection the working copy", choose: () => confirm({ kind: "edit", revision }) },
      { name: "Describe change", description: "Edit the selected change's description (d)", choose: () => describe(revision) },
      { name: "Edit description in editor", description: "Edit the full multiline description in JJ's configured editor", choose: () => openExternal("JJ's description editor", () => repository.editDescription(revision), true) },
      { name: "Rebase change", description: "Source, destination, scope and preview", choose: () => openHistory(revision, "rebase", false) },
      { name: "Rebase change and descendants", description: "Move the selected stack", choose: () => openHistory(revision, "rebase", true) },
      { name: "Squash changes", description: "Source, destination, files and description", choose: () => openHistory(revision, "squash") },
      { name: "Squash interactively", description: "Choose files or hunks in JJ's configured diff editor", choose: () => destination("Squash interactively into", revision, destination => editInteractively({ kind: "squash", revision, destination })) },
      { name: "Split interactively", description: "Choose files or hunks in JJ's configured diff editor", choose: () => editInteractively({ kind: "split", revision }) },
      { name: "Split change", description: "Put selected files in a first change", choose: () => chooseFiles(revision, "Split files", files => ask("First change description", "", description => confirm({ kind: "split", revision, files, description }))) },
      { name: "Create bookmark", description: "Name the selected revision", choose: () => ask("Bookmark name", "", name => confirm({ kind: "bookmark-create", name, revision })) },
      { name: "Abandon change", description: "Remove selection and rebase its descendants", choose: () => confirm({ kind: "abandon", revision }) },
      { name: "Browse changed files", description: "Preview one file at a time", choose: () => browseFiles(revision) },
      { name: "Open in Hunk", description: "Review the selected change in the external Hunk viewer", choose: () => openExternal("Hunk", () => repository.openHunk(revision)) },
      { name: "Absorb into ancestors", description: "Preview automatic fixups into mutable ancestors (a)", choose: () => confirm({ kind: "absorb", revision }) },
      { name: "Change evolution", description: "Browse previous versions and their rewrite diffs (v)", choose: () => showEvolution(revision) },
    ]);
  }
  function updateInlineHint() {
    if (prompt.kind !== "inline") return;
    const source = prompt.source;
    const destination = selected();
    const moving = prompt.action.kind === "rebase" && prompt.action.descendants ? prompt.action.scope : [prompt.source];
    const visible = new Set(revisions.map(revision => revision.commitId));
    const outside = moving.filter(revision => !visible.has(revision.commitId)).length;
    list.markSource(revisions.findIndex(revision => revision.commitId === source.commitId), new Set(moving.map(revision => revision.commitId)));
    const scope = prompt.action.kind === "rebase"
      ? `${prompt.action.descendants ? `Change and descendants: ${moving.length} changes` : "Selected change only"}${outside ? ` · ${outside} outside view` : ""} · Tab scope`
      : "All files · Keep destination description";
    inlineHint.content = terminalText(`${prompt.action.kind === "rebase" ? "Rebase" : "Squash"} from ● ${prompt.source.changeId.slice(0, 8)} → ${destination?.changeId.slice(0, 8) || "Choose destination"}\n${scope}\n● will move · j/k destination · Enter preview · Esc cancel`);
  }
  function startInline(source: Revision, kind: "rebase" | "squash") {
    if (kind === "squash") { resumeInline({ kind: "inline", source, action: { kind } }); return; }
    void run("Loading rebase scope…", async () => {
      const scope = await repository.rebaseScope(source);
      if (!stopped) resumeInline({ kind: "inline", source, action: { kind, descendants: false, scope } });
    });
  }
  function resumeInline(state: Extract<Prompt, { kind: "inline" }>) {
    closePrompt();
    prompt = state;
    list.markSource(revisions.findIndex(revision => revision.commitId === state.source.commitId));
    inlineHint.visible = true;
    result.visible = false;
    message.content = "";
    setFocus("list");
    updateInlineHint();
  }
  function onSelection() {
    if (!replacing && (prompt.kind === "browse" || prompt.kind === "inline")) {
      updateInlineHint();
      updateSearchStatus();
      void loadPreview();
    }
  }
  function onKey(key: KeyEvent) {
    if (stopped) return;
    list.cancelDrag();
    if (key.ctrl && key.name === "c") { key.preventDefault(); stop(); renderer.destroy(); return; }
    if (prompt.kind === "search") {
      if (key.name === "escape") { key.preventDefault(); void finishSearch(true); }
      else if (key.name === "return") { key.preventDefault(); void finishSearch(false).catch(error => report(errorText(error), true)); }
      return;
    }
    if (prompt.kind === "theme") {
      key.preventDefault();
      if (isBusy()) return;
      if (key.name === "escape") {
        applyTheme(prompt.original);
        closePrompt();
      } else if (key.name === "j" || key.name === "down") chooser.moveDown();
      else if (key.name === "k" || key.name === "up") chooser.moveUp();
      else if (key.name === "return") void keepTheme();
      return;
    }
    if (prompt.kind === "inline") {
      key.preventDefault();
      if (isBusy()) return;
      if (key.name === "escape") { closePrompt(); report("Cancelled."); void loadPreview(); }
      else if (key.name === "j" || key.name === "down") list.moveDown();
      else if (key.name === "k" || key.name === "up") list.moveUp();
      else if (key.name === "pageup" || key.name === "pagedown") preview.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, preview.height - 3));
      else if (key.name === "tab" && prompt.action.kind === "rebase") {
        prompt.action.descendants = !prompt.action.descendants;
        updateInlineHint();
      } else if (key.name === "return") {
        const destination = selected();
        if (!destination || destination.commitId === prompt.source.commitId) { report("Choose a different destination revision.", true); return; }
        const action: Mutation = prompt.action.kind === "rebase"
          ? { kind: "rebase", revision: prompt.source, destination, descendants: prompt.action.descendants }
          : { kind: "squash", revision: prompt.source, destination, files: [], description: destination.description };
        confirm(action);
      }
      return;
    }
    if (prompt.kind === "form") {
      if (prompt.form.handleKey(key) === "close") { closePrompt(); void loadPreview(); }
      return;
    }
    if (prompt.kind !== "browse") {
      if (isBusy()) { key.preventDefault(); return; }
      if (key.name === "escape") { key.preventDefault(); if (prompt.kind === "confirm" && prompt.back) prompt.back(); else closePrompt(); void loadPreview(); }
      else if (key.name === "pageup" || key.name === "pagedown") { key.preventDefault(); overlayPreview.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, overlayPreview.height - 3)); }
      else if (prompt.kind === "picker") {
        key.preventDefault();
        if (isBusy()) return;
        if (key.name === "j" || key.name === "down") chooser.moveDown();
        else if (key.name === "k" || key.name === "up") chooser.moveUp();
        else if (key.name === "return") { const choice = prompt.choices[chooser.getSelectedIndex()]; choice?.choose(); }
      }
      else if (prompt.kind === "confirm" && key.name === "p") { key.preventDefault(); confirm(prompt.action); }
      else if (key.name === "return") { key.preventDefault(); void submit(); }
      return;
    }
    const name = key.sequence === "?" ? "?" : key.name;
    if (name === "q") { key.preventDefault(); stop(); renderer.destroy(); return; }
    if (name === "tab") { key.preventDefault(); setFocus(focus === "list" ? "preview" : "list"); return; }
    if (["j", "k", "up", "down", "pageup", "pagedown"].includes(name)) {
      key.preventDefault();
      const direction = name === "k" || name === "up" || name === "pageup" ? -1 : 1;
      if (name === "pageup" || name === "pagedown") preview.scrollBy(direction * Math.max(1, preview.height - 3));
      else if (focus === "preview") preview.scrollBy(direction);
      else if (direction < 0) list.moveUp(); else list.moveDown();
      return;
    }
    if (name === "?") { key.preventDefault(); show(HELP, "Help"); return; }
    if (name === "s" && !key.shift && key.sequence !== "S") {
      key.preventDefault();
      void previews.load({ target: "main", title: "Working-copy status", loading: "Loading status…",
        read: () => repository.status(), errorTitle: "Status error" });
      return;
    }
    if (isBusy()) return;
    if (key.ctrl && name === "f") { key.preventDefault(); beginSearch(); return; }
    if (key.ctrl && (name === "n" || name === "p")) { key.preventDefault(); nextMatch(name === "n" ? 1 : -1); return; }
    if (key.ctrl && name === "o") {
      key.preventDefault();
      if (returnPoint) { const view = returnPoint; returnPoint = null; displayView(view); void loadPreview(); }
      return;
    }
    if (name === "escape") { key.preventDefault(); search = { query: "", matches: [] }; updateSearchStatus(); return; }
    if (["@", "[", "]"].includes(key.sequence)) {
      key.preventDefault(); jump(key.sequence === "@" ? "working copy" : key.sequence === "[" ? "parent" : "child"); return;
    }
    if (name === "t") { key.preventDefault(); pickTheme(); return; }
    if (key.sequence === "R" || key.sequence === "S" || (key.shift && (name === "r" || name === "s"))) {
      key.preventDefault();
      const revision = selected();
      if (revision) startInline(revision, key.sequence === "R" || name === "r" ? "rebase" : "squash");
      return;
    }
    if (name === "space" || key.sequence === " ") { key.preventDefault(); const revision = selected(); if (revision) actions(revision); return; }
    if (name === "b") { key.preventDefault(); showBookmarks(); return; }
    if (name === "o") { key.preventDefault(); showOperations(); return; }
    if (name === "u") { key.preventDefault(); undo(); return; }
    if (name === "f") { key.preventDefault(); const revision = selected(); if (revision) browseFiles(revision); return; }
    if (name === "a" || name === "v") {
      key.preventDefault();
      const revision = selected();
      if (revision) {
        if (name === "a") confirm({ kind: "absorb", revision });
        else showEvolution(revision);
      }
      return;
    }
    if (name === "return") { key.preventDefault(); void loadPreview(); return; }
    if (name === "r") { key.preventDefault(); void run("Refreshing history…", () => refresh()); }
    else if (name === "/" || key.sequence === "/") { key.preventDefault(); openPrompt({ kind: "revset" }, "Revset", revset); }
    else if (name === "d" || name === "n" || name === "e") {
      key.preventDefault();
      const revision = selected();
      if (!revision) { report("Select a revision first.", true); return; }
      if (name === "e") void run("Switching working copy…", async () => {
        if (await review.prepare({ kind: "edit", revision })) await applyReviewed();
      });
      else if (name === "n") openPrompt({ kind: "new", parent: revision }, `Create child of ${revision.changeId.slice(0, 8)}?`);
      else describe(revision);
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(resultTimer);
    clearTimeout(searchTimer);
    ++searchRequest;
    if (prompt.kind === "form") prompt.form.dispose();
    previews.dispose();
    review.dispose();
    renderer.keyInput.off("keypress", onKey);
    list.off("selectionChanged", onSelection);
    chooser.off("selectionChanged", previewChoice);
    app.destroyRecursively();
  }
  searchInput.on("input", queueSearch);
  list.canDrag = () => !stopped && !isBusy() && prompt.kind === "browse";
  list.onRebaseDrop = (revision, destination) => confirm({ kind: "rebase", revision, destination, descendants: false });
  list.onBookmarkDrop = (name, revision) => confirm({ kind: "bookmark-move", name, revision });
  list.onDragHint = text => report(text || "Ready. ? shows all controls.");
  app.onMouse = event => list.handleDragMouse(event);
  renderer.keyInput.on("keypress", onKey);
  list.on("selectionChanged", onSelection);
  chooser.on("selectionChanged", previewChoice);
  return { start: async () => { setFocus("list"); await run("Loading history…", () => refresh()); }, stop };
}
