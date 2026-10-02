import { ListSearch, RevisionSearch, matchingRevisions } from "./ui/revision-search";
import { actionForKey, defaultBindings, inlineActions, keyLabel, presetNames, type Keybindings, type Action } from "./ui/keybindings";
import { applyCompletion, revsetCompletions, type Completion } from "./revisions/revset-completion";
import { MutationReview } from "./history/mutation-review";
import { PreviewSession } from "./preview/preview-session";
import { setTerminalColors, setTheme, themes, themeNames, themeLabels, type ThemeName, type Theme } from "./ui/theme";
import { highlightJjText, revisionPrefixes } from "./ui/jj-highlighting";
import { ChangePreview } from "./preview/change-preview";
import {
  BorderChars, BoxRenderable, InputRenderable, ScrollBoxRenderable, SelectRenderable,
  TextRenderable, TextareaRenderable, type CliRenderer, type KeyEvent, type TerminalColors,
} from "@opentui/core";
import { TreeComparisonView } from "./history/tree-comparison";
import { ActionOverlay } from "./ui/action-overlay";
import { HistoryForm } from "./history/history-form";
import { RevisionLog } from "./revisions/revision-log";
import { FileList } from "./revisions/file-list";
import { Repository } from "./repository/repository";
import { terminalText } from "./terminal-text";
import { shortChangeId, type InteractiveAction, type Mutation, type PreparedMutation, type Revision, type Snapshot, type Bookmark, type ChangedFile } from "./repository/model";

type Choice = { name: string; description: string; choose: () => void; preview?: () => Promise<string>; key?: string; header?: boolean };

type Prompt =
  | { kind: "browse" }
  | { kind: "theme"; original: Theme }
  | { kind: "inline"; source: Revision; action: { kind: "rebase"; descendants: boolean; scope: Revision[] } | { kind: "squash" } }
  | { kind: "form"; form: HistoryForm }
  | { kind: "search"; view: NavigationView; previous: Search; returnPoint: NavigationView | null }
  | { kind: "revset" }
  | { kind: "describe"; revision: Revision; original: string; discard: boolean }
  | { kind: "picker"; title: string; all: Choice[]; choices: Choice[]; attach?: () => void }
  | { kind: "files"; revision: Revision; files: ChangedFile[] }
  | { kind: "text"; label: string; accept: (value: string) => void }
  | { kind: "help" }
  | { kind: "confirm"; action: Mutation; edit: (() => void) | null; back: (() => void) | null };

type Search = { query: string; matches: Revision[] };
type NavigationView = { snapshot: Snapshot; bookmarks: Bookmark[]; index: number; top: number; outside: ReadonlySet<string> };

const menuActions = new Set<Action>(["edit", "new", "describe", "describeExternal", "rebase", "squash", "split", "git", "abandon", "files", "absorb", "evolution", "status", "undo", "loadMore"]);
function helpSections(bindings: Keybindings): { title: string; rows: [string, string][] }[] {
  const keys = (actions: Action[]) => actions.some(action => bindings[action].length)
    ? actions.filter(action => bindings[action].length).map(action => keyLabel(bindings, action)).join(" / ")
    : actions.some(action => menuActions.has(action)) ? "(Space menu)" : "(unbound)";
  return [
    { title: "Navigate", rows: [
      [keys(["down", "up"]), "Move through revisions"],
      [keys(["focus"]), "Switch focus between the revisions and the preview"],
      [keys(["workingCopy", "parent", "child"]), "Jump to the working copy / parent / child; choose when there are several"],
      [keys(["return"]), "Return from a temporary reveal to the previous view"],
      [keys(["loadMore"]), "Load 200 more revisions, keeping the selection"],
      [keys(["refresh"]), "Refresh history now; external changes also refresh automatically"],
      [keys(["help"]), "Show this help"],
      [keys(["lastError"]), `Show the last error in full; Esc or ${keyLabel(bindings, "diff")} returns to the diff`],
      [`${keys(["quit"])} / Ctrl-C`, "Quit"],
    ] },
    { title: "Preview pane", rows: [
      [keys(["togglePreview"]), "Hide or show the preview; the graph expands when hidden"],
      [keys(["pageUp", "pageDown"]), "Scroll the preview by page"],
      [keys(["previewUp", "previewDown"]), "Scroll the preview by line, keeping graph focus"],
      [keys(["previewHalfUp", "previewHalfDown"]), "Scroll the preview by half page"],
      [keys(["diff"]), "Show the selected revision's diff"],
      [keys(["files"]), "Expand changed files under the revision; j/k file, Enter focus diff, h/Left/Esc collapse"],
      [keys(["status"]), "Working-copy status; Esc returns to the change preview"],
      [keys(["theme"]), "Choose a theme, preview and save"],
    ] },
    { title: "Search & revsets", rows: [
      [keys(["filter"]), "Enter a revset; empty restores the jj log default; Tab completes bookmarks and functions"],
      [keys(["search"]), "Search descriptions, bookmarks and ID prefixes in the active revset"],
      [keys(["nextMatch", "previousMatch"]), "Next / previous search match, wrapping"],
      [keys(["clearSearch"]), "Clear the accepted search"],
      ["/ in pickers", "Search all revisions in destination lists, including older history"],
    ] },
    { title: "Edit changes", rows: [
      [keys(["describe"]), "Describe the selected change in the app, including multiline text"],
      [keys(["describeExternal"]), "Describe the selected change in JJ's configured editor"],
      [keys(["new"]), "Create an empty child of the selection immediately"],
      [keys(["edit"]), "Make the selection the working copy immediately"],
      [keys(["rebase"]), "Choose a rebase destination in the graph"],
      [keys(["rebaseScope"]), `While choosing a rebase destination, include descendants; ${keyLabel(bindings, "loadMore")} and ${keyLabel(bindings, "togglePreview")} also apply`],
      [keys(["squash"]), "Choose a squash destination in the graph"],
      ["Drag change", "Drop a change onto another change to preview a rebase"],
      [keys(["split"]), "Split selected files into a new first change"],
      [keys(["abandon"]), "Preview abandoning the selected change"],
      [keys(["absorb"]), "Preview absorbing edits into mutable ancestors"],
      [keys(["actions"]), "Action menu grouped by task, showing each item's key; / filters by name"],
    ] },
    { title: "History & recovery", rows: [
      [keys(["evolution"]), "Browse the selected change's evolution and each version's rewrite diff"],
      [keys(["operations"]), "Operation history: inspect an operation or restore its state"],
      [keys(["undo"]), "Preview undo of the latest operation"],
    ] },
    { title: "Bookmarks & remotes", rows: [
      [keys(["bookmarks"]), "Local and remote bookmarks: move, rename, delete, track or untrack"],
      [keys(["git"]), "Git remotes: fetch and push after a review"],
      ["Drag [bookmark]", "Drop a local bookmark onto another change to preview a move; Esc or dropping outside the graph cancels"],
    ] },
    { title: "Symbols", rows: [
      ["@", "Working copy"],
      ["!", "Conflict"],
      ["●", "Change that will move in the pending rebase or squash"],
      ["*", "Search match"],
      ["+", "Revision outside the active revset in a temporary view"],
      ["~", "Omitted history in the ancestry lines"],
      ["[bookmark]", "Local bookmark label; drag it to move the bookmark"],
    ] },
    { title: "In prompts (fixed keys; browse overrides do not apply)", rows: [
      ["j/k or arrows", "Choose an item"],
      ["Enter", "Apply / confirm; newline in the description editor"],
      ["Ctrl-S or Ctrl-D", "Save the description"],
      ["PgUp / PgDn", "Scroll the overlay preview"],
      ["Esc", "Go back one level, or cancel at the top; press twice to discard description edits"],
    ] },
  ];
}

function fieldColors(colors: Theme) {
  return { textColor: colors.text, focusedTextColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.panel };
}
function chooserColors(colors: Theme) {
  return { ...fieldColors(colors), descriptionColor: colors.muted, selectedBackgroundColor: colors.selected, selectedTextColor: colors.selectedText, selectedDescriptionColor: colors.selectedText };
}
export function createApp(renderer: CliRenderer, repository: Repository, theme: Theme = themes.terminal, saveTheme: (name: ThemeName) => Promise<void> = async () => {}, bindings: Keybindings = defaultBindings, options: { refreshIntervalMs?: number; preset?: string } = {}) {
  const bindingLabel = (action: Action) => keyLabel(bindings, action);
  const presetLabel = options.preset ?? (bindings === defaultBindings ? "jjui" : "custom");
  setTheme(renderer, theme);
  let colors = theme;
  const applyTerminalColors = (detected: TerminalColors) => { setTerminalColors(renderer, detected); applyTheme(colors); };
  const app = new BoxRenderable(renderer, { id: "app", width: "100%", height: "100%", flexDirection: "column", backgroundColor: colors.bg });
  const header = new TextRenderable(renderer, { id: "header", height: 1, fg: colors.accent, content: terminalText(`jj-evolved  /  ${repository.root}`) });
  const filter = new TextRenderable(renderer, { id: "revset", height: 1, fg: colors.muted, content: "revset:" });
  const body = new BoxRenderable(renderer, { id: "body", flexDirection: "row", flexGrow: 1, minHeight: 1 });
  const listBox = new BoxRenderable(renderer, { id: "revision-pane", width: "42%", minWidth: 26, flexShrink: 0, border: true, customBorderChars: { ...BorderChars.single, topRight: "┬", bottomRight: "┴" }, borderColor: colors.accent, title: " Revisions ", backgroundColor: colors.panel });
  const list = new RevisionLog(renderer);
  list.height = 0;
  list.flexGrow = 1;
  const fileList = new FileList(renderer);
  const preview = new ScrollBoxRenderable(renderer, { id: "preview", flexGrow: 1, width: 0, minWidth: 1, border: ["top", "right", "bottom"], borderColor: colors.border, title: " Change preview ", scrollY: true, scrollX: true, contentOptions: { width: "100%", minHeight: 0 } });
  const detail = new ChangePreview(renderer, "preview-text", "Loading repository…");
  const promptLabel = new TextRenderable(renderer, { id: "prompt-label", height: 1, visible: false, fg: colors.accent });
  const input = new InputRenderable(renderer, { id: "prompt-input", visible: false, width: "100%", ...fieldColors(colors), placeholderColor: colors.muted });
  const descriptionInput = new TextareaRenderable(renderer, { id: "description-input", visible: false, width: "100%", height: 0, flexGrow: 1, minHeight: 1, wrapMode: "word", ...fieldColors(colors) });
  const searchInput = new InputRenderable(renderer, { id: "search-input", visible: false, width: "100%", placeholder: "Search active revset", ...fieldColors(colors), placeholderColor: colors.muted });
  const searchStatus = new TextRenderable(renderer, { id: "search-status", visible: false, height: 1, wrapMode: "none", truncate: true, fg: colors.accent });
  const navigationStatus = new TextRenderable(renderer, { id: "navigation-status", visible: false, height: 1, fg: colors.accent, content: `temporary view (up to 40) | + outside filter | ${bindingLabel("return")} return` });
  const message = new TextRenderable(renderer, { id: "message", height: 1, fg: colors.muted, content: "Loading history…" });
  const inlineHint = new TextRenderable(renderer, { id: "inline-action", height: 3, flexShrink: 0, visible: false, fg: colors.accent });
  const filesShortcuts = `${keyLabel(bindings, "down", true)}/${keyLabel(bindings, "up", true)} file  Enter focus diff  ${bindingLabel("focus")} focus  ${bindingLabel("togglePreview")} preview  ${bindingLabel("pageUp")}/${bindingLabel("pageDown")} scroll\nh/Left/Esc/${bindingLabel("files")} collapse  ${bindingLabel("quit")} quit`;
  const shortcuts = new TextRenderable(renderer, { id: "shortcuts", height: 2, fg: colors.accent });
  const chooser = new SelectRenderable(renderer, { id: "action-choices", visible: false, width: "100%", height: "45%", minHeight: 2, options: [], ...chooserColors(colors), showDescription: true, itemSpacing: 0, wrapSelection: false });
  const overlay = new ActionOverlay(renderer, "action-overlay");
  overlay.visible = false;
  const overlayPreview = new ScrollBoxRenderable(renderer, { id: "overlay-preview", flexGrow: 1, minHeight: 1, contentOptions: { width: "100%", minHeight: 0 }, border: true, borderColor: colors.border, title: " Preview " });
  const overlayText = new ChangePreview(renderer, "overlay-preview-text");
  const comparison = new TreeComparisonView(renderer, "confirmation-trees");
  const helpBox = new BoxRenderable(renderer, { id: "help", visible: false, width: "100%", paddingRight: 1, flexDirection: "column", flexShrink: 0 });
  overlayPreview.add(comparison);
  overlayPreview.add(overlayText);
  overlayPreview.add(helpBox);
  overlay.fields.add(promptLabel);
  overlay.fields.add(input);
  overlay.body.add(descriptionInput);
  const suggestions = new TextRenderable(renderer, { id: "revset-suggestions", visible: false, height: 5, fg: colors.text, wrapMode: "none", truncate: true });
  overlay.body.add(suggestions);
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
  let historyLimit = 200;
  let refreshRequest = 0;
  let defaultRevset = "all()";
  let revset = defaultRevset;
  let currentSnapshot: Snapshot = { root: repository.root, revisions: [], graph: [] };
  let currentBookmarks: Bookmark[] = [];
  let outsideFilter: ReadonlySet<string> = new Set();
  let returnPoint: NavigationView | null = null;
  let search: Search = { query: "", matches: [] };
  let searchCandidates: Revision[] = [];
  let searchBookmarks: Bookmark[] = [];
  let searchRequest = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let pickerSearch: RevisionSearch | ListSearch<Choice> | null = null;
  let prompt: Prompt = { kind: "browse" };
  let levels: (() => void)[] = [];
  let completionItems: Completion[] = [];
  let completionOriginal = "";
  let completionIndex = -1;
  let completing = false;
  let busy = false;
  let running: Promise<void> | null = null;
  let stopped = false;
  let activity = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let checkingUpdates = false;
  let observedOperation: string | null = null;
  let refreshError = "";
  let replacing = false;
  let focusRefreshPending = false;
  let previewNavigation = 0;
  let lastSelection = -Infinity;
  let restorePreviewScroll: (() => void) | undefined;
  let previewTitle = "Change preview";
  let lastError = "";
  overlay.onError = text => { lastError = text; };
  let shown = "";
  let shownError = false;
  const review = new MutationReview(repository, refreshAfterMutation);
  const previews = new PreviewSession(({ target, text, title, keepScroll }) => {
    if (target === "overlay") {
      comparison.setTrees(null);
      helpBox.visible = false;
      overlayText.visible = true;
      overlayPreview.title = ` ${title} `;
      overlayText.content = text;
      overlayPreview.scrollTo(0);
    } else {
      setPreviewTitle(title);
      detail.content = text;
      if (!keepScroll) preview.scrollTo(0);
    }
  });
  function isBusy() { return busy || review.applying; }
  // Help is a read-only overlay and expanded files stay in the graph, so refreshes continue underneath both.
  const idle = () => prompt.kind === "browse" || prompt.kind === "help" || prompt.kind === "files";
  const statusShown = () => ["Working-copy status", "Status error"].includes(previewTitle);
  let focus: "list" | "preview" = "list";

  function selected() { return revisions[list.getSelectedIndex()]; }
  function setMessage(text: string, error = false) {
    shown = text;
    shownError = error;
    message.fg = error ? colors.conflict : colors.muted;
    message.content = terminalText(text);
  }
  function errorSummary(text: string) {
    const suffix = ` · ${bindingLabel("lastError")} full error`;
    const line = text.split("\n")[0] ?? "";
    const room = Math.max(8, renderer.width - suffix.length);
    return `${line.length > room ? `${line.slice(0, room - 1)}…` : line}${suffix}`;
  }
  function report(text: string, error = false) {
    if (stopped) return;
    if (error) lastError = text;
    if (overlay.visible) { setMessage(""); overlay.report(text, error); return; }
    setMessage(error ? errorSummary(text) : text, error);
  }
  function setPreviewTitle(title: string) {
    previewTitle = title;
    preview.title = ` ${title}${focus === "preview" ? " (focused)" : ""} `;
  }
  function paintPanes() {
    listBox.borderColor = prompt.kind === "inline" ? colors.mode : focus === "list" ? colors.accent : colors.border;
    preview.borderColor = focus === "preview" ? colors.accent : colors.border;
    setPreviewTitle(previewTitle);
    const move = `${keyLabel(bindings, "down", true)}/${keyLabel(bindings, "up", true)}`;
    shortcuts.content = prompt.kind === "files" ? filesShortcuts : `${move} move  ${bindingLabel("filter")} revset  ${bindingLabel("search")} search  ${bindingLabel("nextMatch")}/${bindingLabel("previousMatch")} match  ${bindingLabel("workingCopy")} work  ${bindingLabel("parent")}/${bindingLabel("child")} ancestry  ${bindingLabel("return")} return\n${focus === "preview"
      ? `${move} scroll  ${bindingLabel("pageDown")}/${bindingLabel("pageUp")} page  ${bindingLabel("previewHalfDown")}/${bindingLabel("previewHalfUp")} half page  ${bindingLabel("focus")} back to revisions`
      : `${bindingLabel("diff")} diff  ${bindingLabel("describe")} describe  ${bindingLabel("rebase")}/${bindingLabel("squash")} rebase/squash  ${bindingLabel("actions")} actions  ${bindingLabel("help")} help  ${bindingLabel("quit")} quit`}`;
  }
  function setFocus(next: typeof focus) {
    if (!preview.visible) next = "list";
    focus = next;
    paintPanes();
    if (next === "list") { if (prompt.kind === "files") fileList.focus(); else list.focus(); } else preview.focus();
  }
  function setPreviewVisible(visible: boolean) {
    preview.visible = visible;
    listBox.width = visible ? "42%" : "100%";
    listBox.customBorderChars = visible
      ? { ...BorderChars.single, topRight: "┬", bottomRight: "┴" }
      : BorderChars.single;
    if (!visible) { preview.blur(); setFocus("list"); }
    updateFilesTitle();
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
    overlay.body.marginBottom = 1;
    overlay.top = "8%";
    overlayPreview.visible = true;
    overlay.visible = true;
    setMessage("");
    list.mouseSelectionEnabled = false;
    overlay.report("");
    overlay.hints.content = "Enter apply/select  Esc cancel  PgUp/Dn preview";
    list.blur();
    preview.blur();
  }
  function show(text: string, title: string) {
    ++previewNavigation;
    previews.show({ target: "main", text, title });
  }
  async function loadPreview(debounce?: number) {
    ++previewNavigation;
    if (restorePreviewScroll) renderer.off("frame", restorePreviewScroll);
    restorePreviewScroll = undefined;
    const revision = selected();
    if (!revision) { show(`No revisions match this revset. Press ${bindingLabel("filter")} to change it.`, "No revisions"); return; }
    const metadata = terminalText(`${revision.description.trimEnd() || "(no description)"}\n\nChange   ${revision.changeId}\nCommit   ${revision.commitId}\nAuthor   ${revision.author}\nBookmarks ${revision.bookmarks || "none"}\nParents  ${revision.parents.map(id => id.slice(0, 12)).join(", ") || "none"}\n${revision.workingCopy ? "Working copy  " : ""}${revision.conflict ? `CONFLICT\n${bindingLabel("actions")} → Resolve conflicts opens your configured merge tool.` : ""}`.trimEnd() + "\n\n");
    await previews.load({ target: "main", title: "Change preview", loading: "Loading diff…",
      prefix: metadata, read: () => repository.diff(revision), empty: "Empty change. No file differences.",
      cached: repository.cachedDiff(revision), delay: debounce, key: `change ${revision.changeId}` });
  }
  function errorText(error: unknown) { return terminalText(error instanceof Error ? error.message : String(error)); }
  async function refresh(nextRevset = revset, workingCopy = false, preserveView = false) {
    ++activity;
    focusRefreshPending = false;
    const request = ++refreshRequest;
    const limit = nextRevset === revset ? historyLimit : 200;
    const query = preserveView ? search.query : "";
    list.cancelDrag();
    // Read the ID before the view so a concurrent change costs one extra reload, never a missed one.
    const operation = await repository.snapshotOperationId();
    const [snapshot, bookmarks, candidates] = await Promise.all([
      repository.snapshot(nextRevset, true, limit), repository.bookmarks(),
      query ? repository.navigationRevisions(nextRevset) : Promise.resolve([] as Revision[]),
    ]);
    if (stopped || request !== refreshRequest) return;
    observedOperation = operation;
    // Browsing stays available during reads; preserve the latest view when applying results.
    const previous = selected();
    const top = list.scrollTop;
    const previewTop = preview.scrollTop;
    const errorVisible = preserveView && previewTitle === "Last error";
    const statusVisible = preserveView && previewTitle === "Working-copy status";
    historyLimit = limit;
    ++searchRequest;
    clearTimeout(searchTimer);
    search = { query, matches: matchingRevisions(candidates, bookmarks, query) };
    returnPoint = null;
    outsideFilter = new Set();
    currentSnapshot = snapshot;
    currentBookmarks = bookmarks;
    revisions = snapshot.revisions;
    updateSearchStatus();
    detail.prefixes = overlayText.prefixes = revisionPrefixes(revisions);
    revset = nextRevset;
    updateFilter();
    let index = workingCopy ? revisions.findIndex(item => item.workingCopy) : -1;
    if (index < 0 && previous) index = revisions.findIndex(item => item.commitId === previous.commitId);
    if (index < 0 && previous) {
      const matches = revisions.filter(item => item.changeId === previous.changeId);
      if (matches.length === 1) index = revisions.findIndex(item => item.changeId === previous.changeId);
    }
    replacing = true;
    list.setSnapshot(snapshot, bookmarks);
    if (revisions.length) list.setSelectedIndex(Math.max(0, index));
    if (preserveView) list.scrollTop = top;
    replacing = false;
    updateSearchStatus();
    const previewRead = statusVisible
      ? previews.load({ target: "main", title: "Working-copy status", loading: "Loading status…", read: () => repository.status(), errorTitle: "Status error", key: "status" })
      : prompt.kind === "files" ? followFiles()
      : !errorVisible ? loadPreview() : undefined;
    const navigation = previewNavigation;
    await previewRead;
    if (preserveView && !stopped && navigation === previewNavigation) {
      // New diff content gets its scroll extent during layout, after this read completes.
      restorePreviewScroll = () => {
        restorePreviewScroll = undefined;
        if (!stopped && navigation === previewNavigation) preview.scrollTo(previewTop);
      };
      renderer.once("frame", restorePreviewScroll);
    }
  }

  function onTerminalFocus() {
    if (stopped) return;
    repository.clearDiffs();
    focusRefreshPending = true;
    if (!idle() && !review.applying) {
      review.cancel();
      const warning = "Preview may be stale. Press p to review again.";
      if (prompt.kind === "form") prompt.form.report(warning, true);
      else report(prompt.kind === "confirm" ? warning : "Focus returned; refresh pending. Input preserved.", true);
    }
    scheduleFocusRefresh();
  }
  function scheduleFocusRefresh() {
    // Wait for synchronous prompt transitions to finish before deciding whether to refresh.
    queueMicrotask(() => {
      if (stopped || !focusRefreshPending || isBusy() || !idle()) return;
      if (returnPoint) {
        report(`Focus refresh pending: ${bindingLabel("return")} returns to the active revset and refreshes.`);
        return;
      }
      void run(null, () => refresh(revset, false, true));
    });
  }
  function updateFilter() {
    filter.content = terminalText(`revset: ${revset}  ·  ${revisions.length} revisions${returnPoint ? " · context view" : currentSnapshot.hasMore ? ` · ${bindingLabel("loadMore")} load 200 more` : ""}`);
  }
  async function loadMoreHistory() {
    if (returnPoint) { report(`Press ${bindingLabel("return")} to return to history before loading more.`); return; }
    if (!currentSnapshot.hasMore) { report("All revisions in this revset are loaded."); return; }
    const view = captureView();
    const request = ++refreshRequest;
    const limit = historyLimit + 200;
    const snapshot = await repository.snapshot(revset, true, limit);
    if (stopped || request !== refreshRequest || currentSnapshot !== view.snapshot || returnPoint) return;
    historyLimit = limit;
    const current = captureView();
    const selectedId = current.snapshot.revisions[current.index]?.commitId;
    const index = snapshot.revisions.findIndex(item => item.commitId === selectedId);
    displayView({ ...current, snapshot, index: Math.max(0, index) });
    updateInlineHint();
  }
  function refreshedView(snapshot: Snapshot, bookmarks: Bookmark[], previous: NavigationView): NavigationView {
    const selected = previous.snapshot.revisions[previous.index];
    let index = snapshot.revisions.findIndex(item => item.commitId === selected?.commitId);
    if (index < 0 && selected) {
      const matches = snapshot.revisions.filter(item => item.changeId === selected.changeId);
      if (matches.length === 1) index = snapshot.revisions.indexOf(matches[0]!);
    }
    if (index < 0) index = Math.max(0, Math.min(previous.index, snapshot.revisions.length - 1));
    return { snapshot, bookmarks, index, top: previous.top, outside: new Set() };
  }
  async function checkForUpdates() {
    if (stopped || checkingUpdates || isBusy() || !idle() || list.dragActive) return;
    checkingUpdates = true;
    const generation = activity;
    const valid = () => !stopped && activity === generation && !isBusy() && idle() && !list.dragActive;
    try {
      let operation = await repository.snapshotOperationId();
      if (!valid()) return;
      if (operation === observedOperation) {
        if (refreshError) { report("Ready."); refreshError = ""; }
        return;
      }
      // status snapshots too, so it must precede the ID that the re-check compares against.
      const status = statusShown() ? await repository.status() : undefined;
      if (status !== undefined) operation = await repository.operationId();
      if (!valid()) return;
      const oldView = captureView();
      const oldReturn = returnPoint;
      const previous = selected();
      const [snapshot, bookmarks, candidates] = await Promise.all([
        repository.snapshot(revset, true, historyLimit), repository.bookmarks(),
        search.query ? repository.navigationRevisions(revset) : Promise.resolve([] as Revision[]),
      ]);
      const base = refreshedView(snapshot, bookmarks, oldReturn ?? oldView);
      let view = base;
      let restoredReturn: NavigationView | null = null;
      if (oldReturn && previous) {
        const targets = await repository.navigationRevisions(`present(${previous.changeId})`);
        const target = targets.find(item => item.commitId === previous.commitId) ?? (targets.length === 1 ? targets[0] : undefined);
        if (target) {
          const context = `${target.commitId} | latest(parents(${target.commitId}) | children(${target.commitId}), 39)`;
          const [nearby, included] = await Promise.all([repository.snapshot(context, true), repository.navigationRevisions(`(${context}) & (${revset})`)]);
          view = refreshedView(nearby, bookmarks, oldView);
          const ids = new Set(included.map(item => item.commitId));
          view.outside = new Set(nearby.revisions.filter(item => !ids.has(item.commitId)).map(item => item.commitId));
          restoredReturn = base;
        }
      }
      // A command or user interaction during the read invalidates this result.
      if (await repository.operationId() !== operation || !valid()) return;
      observedOperation = operation;
      if (refreshError) report("Ready.");
      refreshError = "";
      const previewTop = preview.scrollTop;
      const title = previewTitle;
      const statusView = statusShown();
      if (search.query) search = { query: search.query, matches: matchingRevisions(candidates, bookmarks, search.query) };
      returnPoint = restoredReturn;
      displayView(view);
      if (statusView) { if (status !== undefined) { ++previewNavigation; previews.show({ target: "main", text: status, title: "Working-copy status", keepScroll: true }, "status"); } }
      else if (prompt.kind === "files") await followFiles();
      else if (title !== "Last error" && JSON.stringify(previous) !== JSON.stringify(selected())) await loadPreview();
      if (valid()) preview.scrollTo(previewTop);
    } catch (error) {
      const text = errorText(error);
      if (valid() && text !== refreshError) {
        refreshError = text;
        report(`Auto-refresh failed; will retry. ${text}`, true);
      }
    } finally { checkingUpdates = false; }
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
    updateFilter();
    updateSearchStatus();
  }
  function updateSearchStatus() {
    navigationStatus.visible = returnPoint !== null;
    searchStatus.visible = search.query.length > 0 || prompt.kind === "search";
    const index = search.matches.findIndex(item => item.commitId === selected()?.commitId);
    const position = search.matches.length ? (index < 0 ? `${search.matches.length} matches` : `${index + 1}/${search.matches.length}`) : search.query ? "No matches" : "Type to search";
    const hints = prompt.kind === "search" ? "Enter keep  Esc cancel" : `${bindingLabel("nextMatch")}/${bindingLabel("previousMatch")} next/prev`;
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
    search = { query, matches: query ? matchingRevisions(searchCandidates, searchBookmarks, query) : [] };
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
    }, true);
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
    }, true);
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
        choose: () => { closePrompt(); void run("Navigating…", () => navigate(item), true); },
      })));
    }, true);
  }
  // Quiet actions (navigation, overlay loads, previews) restore the message line instead of announcing completion.
  // Without a label the action is silent: the message line changes only to report an error or clear an old one.
  async function run(label: string | null, action: () => Promise<void>, quiet = false) {
    if (isBusy() || stopped) return;
    busy = true;
    const done = Promise.withResolvers<void>();
    running = done.promise;
    const previous = shown, previousError = shownError;
    if (label !== null) report(label);
    try {
      await action();
      if (label === null) { if (shownError) report("Ready."); }
      else if (!quiet) { if (overlay.visible) overlay.report(""); else report("Ready."); }
      else if (overlay.visible) overlay.report("");
      else if (shown === label) setMessage(previous, previousError);
    }
    catch (error) {
      if (prompt.kind === "confirm" && prompt.edit) prompt.edit();
      report(errorText(error), true);
    }
    finally { busy = false; running = null; done.resolve(); scheduleFocusRefresh(); }
  }
  function updateCompletions() {
    if (prompt.kind !== "revset" || completing) return;
    completionOriginal = input.value;
    completionIndex = -1;
    completionItems = revsetCompletions(input.value, input.cursorOffset, currentBookmarks);
    renderCompletions();
  }
  function renderCompletions() {
    suggestions.visible = prompt.kind === "revset";
    const first = Math.max(0, completionIndex - 3);
    suggestions.content = completionItems.length ? terminalText(completionItems.slice(first, first + 4).map((item, index) => `${first + index === completionIndex ? ">" : " "} ${item.label}`).join("\n") + `\n${completionItems.length} suggestions · Tab / Shift-Tab cycle`) : "No suggestions · Enter applies your expression";
  }
  function completeRevset(backwards: boolean) {
    if (!completionItems.length) return;
    completionIndex = (completionIndex + (backwards ? (completionIndex < 0 ? 0 : -1) : 1) + completionItems.length) % completionItems.length;
    const result = applyCompletion(completionOriginal, completionItems[completionIndex]!);
    completing = true;
    input.value = result.value;
    input.cursorOffset = result.cursor;
    completing = false;
    renderCompletions();
  }
  function escHint(top: string) { return `Esc ${levels.length ? "back" : top}`; }
  function pushLevel() {
    const current = prompt;
    if (current.kind === "picker") {
      const chosen = current.choices[chooser.getSelectedIndex()], hints = overlay.hints.content;
      levels.push(() => {
        pick(current.title, current.all, { attach: current.attach, replace: true });
        let index = chosen ? current.all.indexOf(chosen) : -1;
        if (index < 0 && chosen) index = current.all.findIndex(choice => choice.name === chosen.name && choice.description === chosen.description);
        if (index >= 0) chooser.setSelectedIndex(index);
        overlay.hints.content = hints;
      });
    } else if (current.kind === "text") {
      const value = input.value;
      levels.push(() => openPrompt(current, current.label, value));
    } else if (current.kind === "inline") levels.push(() => resumeInline(current));
  }
  function goBack() {
    const level = levels.pop();
    if (!level) { closePrompt(); void loadPreview(); return; }
    pickerSearch?.dispose();
    pickerSearch = null;
    review.cancel();
    descriptionInput.blur();
    descriptionInput.visible = false;
    prompt = { kind: "browse" };
    level();
  }
  function closePrompt() {
    pickerSearch?.dispose();
    pickerSearch = null;
    suggestions.visible = false;
    if (prompt.kind === "form") prompt.form.dispose();
    const keepPreview = prompt.kind === "help";
    prompt = { kind: "browse" };
    levels = [];
    review.cancel();
    if (!keepPreview) previews.cancel();
    overlay.visible = false;
    helpBox.visible = false;
    overlayText.visible = true;
    inlineHint.visible = false;
    list.markSource(null);
    list.mouseSelectionEnabled = true;
    input.blur();
    descriptionInput.blur();
    descriptionInput.visible = false;
    chooser.blur();
    chooser.visible = false;
    fileList.blur();
    list.collapse();
    listBox.title = " Revisions ";
    input.visible = false;
    promptLabel.visible = false;
    setFocus(focus);
    scheduleFocusRefresh();
  }
  function openPrompt(next: Exclude<Prompt, { kind: "browse" }>, label: string, value = "") {
    pushLevel();
    pickerSearch?.dispose();
    pickerSearch = null;
    activateOverlay(label);
    chooser.visible = false;
    prompt = next;
    suggestions.visible = false;
    if (next.kind === "describe" || next.kind === "revset" || next.kind === "text") {
      overlay.height = 12;
      overlay.top = "20%";
      overlayPreview.visible = false;
    }
    if (next.kind === "describe" || next.kind === "revset" || next.kind === "text") showOverlay(label, "Action");
    if (next.kind === "text") overlay.hints.content = `Enter apply  ${escHint("cancel")}`;
    promptLabel.content = terminalText(`${label}  [${next.kind === "describe" ? "^S save" : "Enter apply"} · ${escHint("cancel")}]`);
    promptLabel.visible = next.kind !== "confirm";
    input.placeholder = "";
    input.value = terminalText(value);
    descriptionInput.visible = next.kind === "describe";
    input.visible = next.kind !== "confirm" && next.kind !== "describe";
    if (!input.visible) { list.blur(); preview.blur(); } else input.focus();
    if (next.kind === "describe") {
      overlay.height = "65%";
      overlay.body.marginBottom = 0;
      overlay.top = "12%";
      descriptionInput.setText(terminalText(value));
      descriptionInput.gotoBufferEnd();
      descriptionInput.focus();
      next.original = descriptionInput.plainText;
      overlay.hints.content = `^S save · Enter newline · ${escHint("cancel")}`;
    }
    if (next.kind === "revset") {
      overlay.height = 15;
      overlay.hints.content = `Tab complete/cycle  Enter apply  ${escHint("cancel")}`;
      updateCompletions();
    }
    if (next.kind === "confirm") overlay.hints.content = `Enter apply  p refresh preview  ${escHint("cancel")}  PgUp/Dn scroll`;
  }
  async function submit() {
    if (isBusy()) return;
    const current = prompt;
    const value = current.kind === "describe" ? descriptionInput.plainText : input.value;
    if (current.kind === "text") { current.accept(value); return; }
    if (current.kind === "confirm") { await run("Applying jj operation…", applyReviewed); return; }
    if (current.kind === "revset") await run("Loading revset…", async () => { await refresh(value.trim() || defaultRevset); closePrompt(); });
    else if (current.kind === "describe") await run("Applying jj operation…", async () => {
      if (await review.prepare({ kind: "describe", revision: current.revision, description: value })) await applyReviewed();
    });
  }
  async function refreshAfterMutation(action: Mutation) {
    if (stopped) return;
    const followWorkingCopy = ["new", "edit", "restore", "undo", "split"].includes(action.kind);
    await refresh(followWorkingCopy ? defaultRevset : revset, followWorkingCopy);
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
  function operationLabel(kind: Mutation["kind"]) {
    return kind.replace("bookmark-", "Bookmark ").replace("git-", "Git ").replace(/^[a-z]/, letter => letter.toUpperCase());
  }
  function openReview(action: Mutation, prepared: PreparedMutation, edit: (() => void) | null, back: (() => void) | null) {
    showOverlay(prepared.summary, `${operationLabel(action.kind)} preview`);
    comparison.setTrees(prepared.trees, action.kind === "rebase" || action.kind === "squash" ? action.kind : undefined);
    openPrompt({ kind: "confirm", action, edit, back }, "Review before applying");
  }
  function confirm(action: Mutation) {
    const previous = prompt;
    const back = previous.kind === "inline" ? () => resumeInline(previous) : previous.kind === "confirm" ? previous.back : null;
    const edit = back || (previous.kind === "text" ? goBack : previous.kind === "confirm" ? previous.edit : null);
    void run("Preparing operation preview…", async () => {
      const prepared = await review.prepare(action);
      if (!prepared) return;
      openReview(action, prepared, edit, back);
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
    }, true);
  }
  function ask(label: string, value: string, accept: (value: string) => void) {
    openPrompt({ kind: "text", label, accept }, label, value);
  }
  function applyTheme(theme: Theme) {
    colors = theme;
    setTheme(renderer, theme);
    const themed: [object[], (colors: Theme) => object][] = [
      [[app], c => ({ backgroundColor: c.bg })],
      [[suggestions], c => ({ fg: c.text })],
      [[header, navigationStatus, searchStatus, promptLabel, inlineHint, shortcuts, result], c => ({ fg: c.accent })],
      [[filter, message], c => ({ fg: c.muted })],
      [[listBox], c => ({ backgroundColor: c.panel })],
      [[overlayPreview], c => ({ borderColor: c.border })],
      [[input, descriptionInput, searchInput], fieldColors],
      [[input, searchInput], c => ({ placeholderColor: c.muted })],
      [[chooser], chooserColors],
    ];
    for (const [widgets, style] of themed) for (const widget of widgets) Object.assign(widget, style(colors));
    paintPanes();
    for (const widget of [list, fileList, detail, overlay, overlayText, comparison]) widget.applyTheme();
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
  function showChoices(choices: Choice[]) {
    if (prompt.kind !== "picker") return;
    prompt.choices = choices;
    const width = Math.max(0, ...choices.map(choice => choice.key?.length ?? 0));
    chooser.options = choices.map(choice => ({
      value: choice.name,
      name: terminalText(choice.header ? `── ${choice.name} ──` : width ? `${(choice.key ?? "").padEnd(width)}  ${choice.name}` : choice.name),
      description: terminalText(width && !choice.header ? `${" ".repeat(width + 2)}${choice.description}` : choice.description),
    }));
    chooser.setSelectedIndex(Math.max(0, choices.findIndex(choice => !choice.header)));
    previewChoice();
  }
  function moveChoice(direction: 1 | -1) {
    if (prompt.kind !== "picker") return;
    let index = chooser.getSelectedIndex() + direction;
    while (prompt.choices[index]?.header) index += direction;
    if (prompt.choices[index]) chooser.setSelectedIndex(index);
  }
  function pick(title: string, choices: Choice[], options: { attach?: () => void; replace?: boolean } = {}) {
    if (!options.replace) pushLevel();
    pickerSearch?.dispose();
    pickerSearch = null;
    activateOverlay(title);
    input.blur();
    input.visible = false;
    promptLabel.visible = false;
    prompt = { kind: "picker", title, all: choices, choices, attach: options.attach };
    chooser.visible = true;
    chooser.showDescription = true;
    chooser.focus();
    overlay.hints.content = `j/k choose  Enter select  ${escHint("close")}  PgUp/Dn preview`;
    showChoices(choices);
    options.attach?.();
  }
  function destination(title: string, source: Revision | null, accept: (revision: Revision) => void, searchImmediately = false) {
    void run("Loading destinations…", async () => {
      const [candidates, bookmarks] = await Promise.all([repository.navigationRevisions("all()"), repository.bookmarks()]);
      if (stopped) return;
      const revisions = candidates.filter(item => item.commitId !== source?.commitId);
      overlayText.prefixes = revisionPrefixes(revisions);
      const choices = (items: Revision[]): Choice[] => items.map(item => ({
        name: `${item.changeId.slice(0, 8)} ${item.description.split("\n")[0] || "(no description)"}`,
        description: `${item.commitId.slice(0, 12)} ${item.bookmarks}`,
        choose: () => { pickerSearch?.dispose(); pickerSearch = null; accept(item); },
        preview: () => repository.diff(item),
      }));
      pick(title, choices(revisions), { attach: () => {
        pickerSearch = new RevisionSearch(renderer, "destination-search", chooser, revisions, bookmarks, matches => {
          if (prompt.kind !== "picker") return;
          showChoices(choices(matches));
          if (!matches.length) showOverlay("No matching destinations. Edit the search or press Escape to clear it.", "Destinations");
          overlay.report(`${matches.length} destinations`);
        });
        overlay.fields.add(pickerSearch.input);
        overlay.hints.content = `j/k choose · / search all destinations · Enter select · ${escHint("close")}`;
      } });
      if (searchImmediately) pickerSearch?.start();
    }, true);
  }
  function chooseFiles(revision: Revision, title: string, accept: (paths: string[]) => void) {
    void run("Loading changed files…", async () => {
      const files = await repository.files(revision);
      if (stopped) return;
      const chosen = new Set<string>();
      function renderFiles(replace = false) {
        pick(title, [
          { name: `Continue with ${chosen.size} files`, description: "Enter to review the selected group", choose: () => {
            if (!chosen.size) { report("Select at least one file.", true); renderFiles(true); return; }
            accept([...chosen]);
          } },
          ...files.map(file => ({ name: `${chosen.has(file.path) ? "[x]" : "[ ]"} ${file.path}`, description: file.status,
            choose: () => { const index = chooser.getSelectedIndex(); chosen.has(file.path) ? chosen.delete(file.path) : chosen.add(file.path); renderFiles(true); chooser.setSelectedIndex(index); },
            preview: () => repository.diff(revision, [file.path]),
          })),
        ], { replace });
      }
      renderFiles();
    }, true);
  }
  function browseFiles(revision: Revision) {
    void run("Loading changed files…", async () => {
      const files = await repository.files(revision);
      if (stopped) return;
      closePrompt();
      prompt = { kind: "files", revision, files };
      list.mouseSelectionEnabled = false;
      list.blur();
      expandFiles(revision, files);
      shortcuts.content = filesShortcuts;
      setFocus("list");
      if (files.length) void loadFilePreview(); else show("Empty change. No changed files.", "Changed files");
    }, true);
  }
  function expandFiles(revision: Revision, files: ChangedFile[], selectPath?: string) {
    const index = revisions.findIndex(item => item.commitId === revision.commitId);
    fileList.setFiles(files, list.continuationPrefix(index), maxFileRows(), selectPath);
    list.expand(index, fileList);
    list.scrollChildIntoView(fileList.id);
    updateFilesTitle();
  }
  // A third of the graph, so a large change scrolls within its list and the surrounding history stays in view.
  function maxFileRows() { return Math.max(3, Math.floor(list.viewport.height / 3)); }
  // Keeps expanded files on their change across refreshes: a rewritten commit reloads its files, a vanished change collapses them.
  async function followFiles() {
    if (prompt.kind !== "files") return;
    const current = prompt;
    const revision = selected();
    if (!revision || revision.changeId !== current.revision.changeId) {
      closeFiles();
      report("Collapsed changed files: the change left the graph.");
      return;
    }
    if (revision.commitId === current.revision.commitId) return;
    const files = await repository.files(revision);
    if (stopped || prompt !== current) return;
    prompt = { kind: "files", revision, files };
    expandFiles(revision, files, fileList.selectedFile?.path);
    if (files.length) await loadFilePreview(); else show("Empty change. No changed files.", "Changed files");
  }
  function fitTitle(text: string, width: number, keepEnd = false) {
    text = terminalText(text).replace(/\n/g, " ");
    const max = Math.max(6, width - 6);
    return text.length <= max ? text : keepEnd ? `…${text.slice(text.length - max + 1)}` : `${text.slice(0, max - 1)}…`;
  }
  function paneWidth(total = renderer.width, previewVisible = preview.visible) { return previewVisible ? Math.max(26, Math.floor(total * 0.42)) : total; }
  function fileTitle(path: string, total = renderer.width) { return fitTitle(path, total - paneWidth(total, true), true); }
  function updateFilesTitle(total?: number) {
    if (prompt.kind !== "files") return;
    const { revision } = prompt;
    listBox.title = ` ${fitTitle(`Revisions · files of ${revision.changeId.slice(0, 8)}`, paneWidth(total))} `;
    const file = fileList.selectedFile;
    if (file) setPreviewTitle(fileTitle(file.path, total));
  }
  async function loadFilePreview() {
    if (prompt.kind !== "files") return;
    const { revision } = prompt;
    const file = fileList.selectedFile;
    if (!file) return;
    ++previewNavigation;
    await previews.load({ target: "main", title: fileTitle(file.path), loading: "Loading diff…", read: () => repository.diff(revision, [file.path]), empty: `No differences in ${file.path}.`, key: `file ${revision.changeId} ${file.path}` });
  }
  function closeFiles() {
    if (prompt.kind !== "files") return;
    const { revision } = prompt;
    const index = revisions.findIndex(item => item.commitId === revision.commitId);
    if (index >= 0) list.setSelectedIndex(index);
    closePrompt();
    void loadPreview();
  }
  function showRemotes() {
    void run("Loading remotes…", async () => {
      const remotes = await repository.remotes();
      if (stopped) return;
      if (!remotes.length) { showOverlay("No Git remotes configured. Add one with jj git remote add in your terminal.", "Remotes"); return; }
      pick("Git remotes", remotes.map(remote => ({
        name: remote.name, description: remote.url,
        choose: () => pick(`Remote ${remote.name}`, [
          { name: "Fetch", description: "Fetch bookmarks and commits from this remote", choose: () => confirm({ kind: "git-fetch", remote: remote.name }) },
          { name: "Push bookmark", description: "Choose one bookmark and review its exact targets", choose: () => {
            void run("Loading push bookmarks…", async () => {
              const bookmarks = await repository.bookmarks();
              if (stopped) return;
              const names = [...new Set(bookmarks.filter(item => !item.remote || item.remote === remote.name && item.tracked).map(item => item.name))];
              if (!names.length) { showOverlay("No local or tracked deleted bookmarks to push.", "Push bookmark"); return; }
              pick(`Push to ${remote.name}`, names.map(name => ({ name,
                description: bookmarks.some(item => item.name === name && !item.remote && item.targets.length) ? "Review before publishing" : "Review remote deletion",
                choose: () => confirm({ kind: "git-push", remote: remote.name, name }),
              })));
            }, true);
          } },
        ]),
      })));
    }, true);
  }
  function showBookmarks() {
    void run("Loading bookmarks…", async () => {
      const bookmarks = await repository.bookmarks();
      if (stopped) return;
      pick("Bookmarks", [{ name: "Git remotes", description: "Fetch and push with a review", choose: showRemotes }, ...bookmarks.map(bookmark => ({
        name: `${bookmark.name}${bookmark.remote ? `@${bookmark.remote}` : ""}${bookmark.conflict ? " !" : ""}`,
        description: `${bookmark.remote ? bookmark.tracked ? "Tracked remote" : "Untracked remote" : "Local"} ${bookmark.targets.map(id => id.slice(0, 12)).join(", ") || "deleted"}`,
        choose: () => {
          if (bookmark.remote) {
            if (bookmark.remote === "git") { showOverlay("The @git bookmark reflects the local Git repository. Manage it with Git.", "Local Git bookmark"); return; }
            pick(`${bookmark.name}@${bookmark.remote}`, [{
              name: bookmark.tracked ? "Untrack bookmark" : "Track bookmark",
              description: bookmark.tracked ? "Keep the local bookmark; stop following remote updates" : "Create or merge a local bookmark and follow future updates",
              choose: () => confirm({ kind: bookmark.tracked ? "bookmark-untrack" : "bookmark-track", name: bookmark.name, remote: bookmark.remote }),
            }]); return;
          }
          pick(bookmark.name, [
            { name: "Move bookmark", description: "Choose a new target revision", choose: () => {
              destination("Bookmark target", null, revision => confirm({ kind: "bookmark-move", name: bookmark.name, revision }));
            } },
            { name: "Rename bookmark", description: "Keep its current targets", choose: () => ask("New bookmark name", bookmark.name, newName => confirm({ kind: "bookmark-rename", name: bookmark.name, newName })) },
            { name: "Delete bookmark", description: "Delete the local bookmark", choose: () => confirm({ kind: "bookmark-delete", name: bookmark.name }) },
          ]);
        },
      }))]);
    }, true);
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
      pick("Operation history", choices, { replace: limit > 50 });
    }, true);
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
      pick("Change evolution", choices, { replace: operationId !== undefined });
      chooser.setSelectedIndex(selectedIndex);
      overlay.hints.content = `j/k version  Enter preview  ${escHint("close")}  PgUp/Dn scroll`;
      if (!page.entries.length) showOverlay("No evolution history is available for this revision.", "Change evolution");
    }, true);
  }
  function undo() {
    void run("Loading latest operation…", async () => {
      const operation = (await repository.operations(1))[0];
      if (!operation) throw new Error("No operation to undo.");
      const action: Mutation = { kind: "undo", operation };
      const prepared = await review.prepare(action);
      if (prepared) openReview(action, prepared, null, null);
    }, true);
  }
  function openHistory(revision: Revision, kind: "rebase" | "squash", descendants = false) {
    closePrompt();
    const form = new HistoryForm(renderer, repository, revision,
      kind === "rebase" ? { kind, descendants } : { kind, files: [], description: "", keepDescription: true },
      review, async () => {
        try { await applyReviewed(); report("Ready."); }
        catch (error) { if (prompt.kind === "browse") report(errorText(error), true); throw error; }
      }, moving => list.markSource(revisions.findIndex(item => item.commitId === revision.commitId), new Set(moving.map(item => item.commitId))));
    form.onError = text => { lastError = text; };
    app.add(form);
    prompt = { kind: "form", form };
    setMessage("");
    list.mouseSelectionEnabled = false;
    list.blur();
    preview.blur();
  }
  function describe(revision: Revision) {
    openPrompt({ kind: "describe", revision, original: "", discard: false }, `Describe ${revision.changeId.slice(0, 8)}`, revision.description.replace(/\n$/, ""));
  }
  function editInteractively(action: InteractiveAction) {
    const editor = action.kind === "describe" ? "description editor" : action.kind === "resolve" ? "merge tool" : "diff editor";
    openExternal(`JJ's ${editor} for ${action.kind}`, () => repository.interactive(action), action.kind === "describe" || action.kind === "resolve");
  }
  function openExternal(name: string, launch: () => Promise<void>, preserveSelection = false) {
    void run(`Opening ${name}…`, async () => {
      closePrompt();
      try {
        renderer.suspend();
        await launch();
      } finally {
        renderer.resume();
        await refresh(preserveSelection ? revset : defaultRevset, !preserveSelection).catch(error => {
          throw new Error(`Refreshing after ${name} failed. Press ${bindingLabel("refresh")} to reload before repeating the action. ${errorText(error)}`);
        });
      }
    });
  }

  function createChild(parent: Revision) {
    void run("Creating child change…", async () => {
      if (await review.prepare({ kind: "new", parent })) await applyReviewed();
    });
  }
  function matchingChoices(choices: Choice[], query: string) {
    const needle = query.toLowerCase();
    const matches: Choice[] = [];
    for (const choice of choices) {
      if (choice.header && matches.at(-1)?.header) matches.pop();
      if (choice.header || choice.name.toLowerCase().includes(needle)) matches.push(choice);
    }
    if (matches.at(-1)?.header) matches.pop();
    return matches;
  }
  function actions(revision: Revision) {
    const key = (action?: Action) => action && bindings[action].length ? keyLabel(bindings, action, true) : "—";
    const header = (name: string): Choice => ({ name, description: "", header: true, choose: () => {} });
    const choices: Choice[] = [
      header("Edit"),
      { key: key("describe"), name: "Describe", description: "Edit the selected change's description in the app", choose: () => describe(revision) },
      { key: key("describeExternal"), name: "Describe in editor", description: "Edit the full multiline description in JJ's configured editor", choose: () => describeExternally(revision) },
      { key: key("edit"), name: "Edit (make working copy)", description: "Make the selected change the working copy", choose: () => confirm({ kind: "edit", revision }) },
      { key: key("new"), name: "New child", description: "Create an empty child of the selected change immediately", choose: () => createChild(revision) },
      header("History"),
      { key: key("rebase"), name: "Rebase", description: "Choose source, destination, scope and preview in a form", choose: () => openHistory(revision, "rebase", false) },
      { key: key(), name: "Rebase with descendants", description: "Move the selected change and its descendants", choose: () => openHistory(revision, "rebase", true) },
      { key: key("squash"), name: "Squash", description: "Choose destination, files and description in a form", choose: () => openHistory(revision, "squash") },
      { key: key(), name: "Squash in diff editor", description: "Choose a destination, then files or hunks in JJ's configured diff editor", choose: () => destination("Squash in diff editor into", revision, destination => editInteractively({ kind: "squash", revision, destination })) },
      { key: key("split"), name: "Split (choose files)", description: "Put selected files in a first change", choose: () => splitChange(revision) },
      { key: key(), name: "Split in diff editor", description: "Choose files or hunks in JJ's configured diff editor", choose: () => editInteractively({ kind: "split", revision }) },
      { key: key("absorb"), name: "Absorb into ancestors", description: "Preview automatic fixups into mutable ancestors", choose: () => confirm({ kind: "absorb", revision }) },
      { key: key("abandon"), name: "Abandon", description: "Remove the selected change and rebase its descendants", choose: () => confirm({ kind: "abandon", revision }) },
      ...(revision.conflict ? [{ key: key(), name: "Resolve conflicts", description: "Open JJ's configured merge tool for this change", choose: () => editInteractively({ kind: "resolve", revision }) }] : []),
      header("Bookmarks & remotes"),
      { key: key(), name: "Create bookmark", description: "Name the selected change", choose: () => ask("Bookmark name", "", name => confirm({ kind: "bookmark-create", name, revision })) },
      { key: key("git"), name: "Git remotes", description: "Fetch, push and select a remote", choose: showRemotes },
      header("Inspect"),
      { key: key("files"), name: "Browse changed files", description: "Preview one file at a time", choose: () => browseFiles(revision) },
      { key: key(), name: "Open in Hunk", description: "Review the selected change in the external Hunk viewer", choose: () => openExternal("Hunk", () => repository.openHunk(revision)) },
      { key: key("evolution"), name: "Change evolution", description: "Browse previous versions and their rewrite diffs", choose: () => showEvolution(revision) },
      header("Repository"),
      { key: key("status"), name: "Working-copy status", description: "Show jj status in the preview", choose: () => { closePrompt(); showStatus(); } },
      { key: key("undo"), name: "Undo", description: "Preview undo of the latest operation", choose: undo },
      { key: key("loadMore"), name: "Load more revisions", description: "Load 200 more revisions, keeping selection", choose: () => { closePrompt(); void run("Loading more history…", loadMoreHistory); } },
    ];
    pick("Actions", choices, { attach: () => {
      pickerSearch = new ListSearch(renderer, "action-search", { moveDown: () => moveChoice(1), moveUp: () => moveChoice(-1), focus: () => chooser.focus() }, choices, matchingChoices, matches => {
        showChoices(matches);
        if (!matches.length) showOverlay("No matching actions. Edit the filter or press Escape to clear it.", "Actions");
      }, "Filter actions by name");
      overlay.fields.add(pickerSearch.input);
      overlay.hints.content = `j/k choose  / filter  Enter select  ${escHint("close")}  PgUp/Dn preview`;
    } });
  }
  function describeExternally(revision: Revision) {
    openExternal("JJ's description editor", () => repository.editDescription(revision), true);
  }
  function splitChange(revision: Revision) {
    chooseFiles(revision, "Split files", files => ask("First change description", "", description => pick("Second change description", [
      { name: "Keep original description", description: revision.description || "(no description)", choose: () => confirm({ kind: "split", revision, files, description, secondDescription: revision.description }) },
      { name: "Edit second description", description: "Enter a replacement description", choose: () => ask("Second change description", revision.description.trim().includes("\n") ? "" : revision.description.trim(), secondDescription => confirm({ kind: "split", revision, files, description, secondDescription })) },
    ])));
  }
  function showStatus() {
    setPreviewVisible(true);
    ++previewNavigation;
    void previews.load({ target: "main", title: "Working-copy status", loading: "Loading status…",
      read: () => repository.status(), errorTitle: "Status error", key: "status" });
  }
  function buildHelp() {
    for (const child of helpBox.getChildren()) child.destroyRecursively();
    const sections = helpSections(bindings);
    const column = Math.max(...sections.flatMap(section => section.rows.map(([key]) => key.length))) + 2;
    sections.forEach((section, index) => {
      helpBox.add(new TextRenderable(renderer, { id: `help-${index}`, content: section.title, fg: colors.accent, flexShrink: 0, marginTop: index ? 1 : 0 }));
      for (const [key, text] of section.rows) {
        const row = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", flexShrink: 0 });
        row.add(new TextRenderable(renderer, { content: key, width: column, flexShrink: 0, fg: colors.changeId }));
        row.add(new TextRenderable(renderer, { content: text, flexGrow: 1, width: 0, minWidth: 1, wrapMode: "word", flexShrink: 0, fg: colors.text }));
        helpBox.add(row);
      }
    });
    helpBox.add(new TextRenderable(renderer, { id: "help-footer", content: "Commands use your installed jj and its repository rules.", fg: colors.muted, flexShrink: 0, marginTop: 1 }));
  }
  function showHelp() {
    activateOverlay(`Help · keys: ${presetLabel}`, false);
    prompt = { kind: "help" };
    input.blur();
    input.visible = promptLabel.visible = chooser.visible = false;
    comparison.setTrees(null);
    overlayText.visible = false;
    buildHelp();
    helpBox.visible = true;
    overlayPreview.title = " Keyboard reference ";
    overlayPreview.scrollTo(0);
    overlay.context.content = terminalText(`Keyboard reference · ${presetLabel === "custom" ? "custom bindings from keybindings.json" : `${presetLabel} preset`}\nSwitch: --keys ${presetNames.join("|")}, JJ_EVOLVED_KEYS, keybindings.json`);
    overlay.hints.content = `Esc/${bindingLabel("help")} close  j/k scroll  PgUp/PgDn page`;
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
      ? `${prompt.action.descendants ? "[x]" : "[ ]"} include descendants (${prompt.action.scope.length} changes)${outside ? ` · ${outside} outside view` : ""} · ${bindingLabel("rebaseScope")} toggle`
      : "All files · Keep destination description";
    inlineHint.content = terminalText(`${prompt.action.kind === "rebase" ? "Rebase" : "Squash"} from ● ${prompt.source.changeId.slice(0, 8)} → ${destination?.changeId.slice(0, 8) || "Choose destination"}\n${scope}\n● will move · ${keyLabel(bindings, "down", true)}/${keyLabel(bindings, "up", true)} destination · ${bindingLabel("search")} search · ${bindingLabel("loadMore")} load more · Enter preview · Esc cancel`);
  }
  function startInline(source: Revision, kind: "rebase" | "squash") {
    if (kind === "squash") { resumeInline({ kind: "inline", source, action: { kind } }); return; }
    void run("Loading rebase scope…", async () => {
      const scope = await repository.rebaseScope(source);
      if (!stopped) resumeInline({ kind: "inline", source, action: { kind, descendants: false, scope } });
    }, true);
  }
  function resumeInline(state: Extract<Prompt, { kind: "inline" }>) {
    closePrompt();
    prompt = state;
    list.markSource(revisions.findIndex(revision => revision.commitId === state.source.commitId));
    inlineHint.visible = true;
    result.visible = false;
    setMessage("");
    listBox.title = ` ${state.action.kind === "rebase" ? "Rebase" : "Squash"}: choose destination `;
    setFocus("list");
    updateInlineHint();
  }
  function onSelection() {
    if (!replacing && (prompt.kind === "browse" || prompt.kind === "inline")) {
      ++activity;
      updateInlineHint();
      updateSearchStatus();
      // Uncached diffs load at once for an isolated move and wait out a run of rapid moves.
      const now = performance.now();
      void loadPreview(now - lastSelection < 150 ? 75 : 0);
      lastSelection = now;
    }
  }
  function onFileSelection() {
    if (prompt.kind !== "files") return;
    ++activity;
    void loadFilePreview();
  }
  function onResize(width: number) {
    updateFilesTitle(width);
    // The graph's new height is known once layout runs, so the cap follows on the next frame.
    if (prompt.kind === "files") renderer.once("frame", () => { if (prompt.kind === "files") fileList.setMaxRows(maxFileRows()); });
  }
  // Arrow keys always move; the bound up/down keys move too.
  function moveKey(key: KeyEvent): -1 | 0 | 1 {
    const action = actionForKey(bindings, key, ["down", "up"]);
    return key.name === "down" || action === "down" ? 1 : key.name === "up" || action === "up" ? -1 : 0;
  }
  function scrollPage(key: KeyEvent, pane: ScrollBoxRenderable) {
    pane.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, pane.height - 3));
  }
  type KeyHandlers = { [K in Prompt["kind"]]: (key: KeyEvent, state: Extract<Prompt, { kind: K }>) => void };
  const keyHandlers: KeyHandlers = {
    browse: browseKey, files: filesKey, inline: inlineKey, search: searchKey, theme: themeKey, help: helpKey,
    form: (key, state) => { if (state.form.handleKey(key) === "close") { closePrompt(); void loadPreview(); } },
    picker: pickerKey, describe: describeKey, confirm: confirmKey, revset: revsetKey, text: dialogKey,
  };
  function onKey(key: KeyEvent) {
    if (stopped) return;
    ++activity;
    list.cancelDrag();
    if (key.ctrl && key.name === "c") { key.preventDefault(); stop(); renderer.destroy(); return; }
    (keyHandlers[prompt.kind] as (key: KeyEvent, state: Prompt) => void)(key, prompt);
  }
  function searchKey(key: KeyEvent) {
    if (key.name === "escape") { key.preventDefault(); void finishSearch(true); }
    else if (key.name === "return") { key.preventDefault(); void finishSearch(false).catch(error => report(errorText(error), true)); }
  }
  function themeKey(key: KeyEvent, state: Extract<Prompt, { kind: "theme" }>) {
    key.preventDefault();
    if (isBusy()) return;
    const move = moveKey(key);
    if (key.name === "escape") {
      applyTheme(state.original);
      closePrompt();
    } else if (move > 0) chooser.moveDown();
    else if (move < 0) chooser.moveUp();
    else if (key.name === "return") void keepTheme();
  }
  function helpKey(key: KeyEvent) {
    key.preventDefault();
    const move = moveKey(key);
    if (key.name === "escape" || actionForKey(bindings, key) === "help") closePrompt();
    else if (move) overlayPreview.scrollBy(move);
    else if (key.name === "pageup" || key.name === "pagedown") scrollPage(key, overlayPreview);
  }
  function filesKey(key: KeyEvent) {
    const action = actionForKey(bindings, key);
    if (action === "togglePreview") { key.preventDefault(); setPreviewVisible(!preview.visible); return; }
    if (key.name === "escape" || key.name === "left" || (key.name === "h" && !key.ctrl && !key.meta && !key.shift) || action === "files") { key.preventDefault(); if (!isBusy()) closeFiles(); return; }
    if (action === "quit") { key.preventDefault(); stop(); renderer.destroy(); return; }
    if (action === "focus" || key.name === "return") {
      key.preventDefault();
      if (key.name === "return" && !preview.visible) setPreviewVisible(true);
      setFocus(action === "focus" && focus === "preview" ? "list" : "preview");
      return;
    }
    if (action === "down" || action === "up") {
      key.preventDefault();
      const direction = action === "up" ? -1 : 1;
      if (focus === "preview") { ++previewNavigation; preview.scrollBy(direction); }
      else if (direction < 0) fileList.moveUp(); else fileList.moveDown();
      return;
    }
    if (action === "pageUp" || action === "pageDown" || action === "previewHalfUp" || action === "previewHalfDown" || action === "previewUp" || action === "previewDown") {
      key.preventDefault();
      const direction = action === "pageUp" || action === "previewHalfUp" || action === "previewUp" ? -1 : 1;
      ++previewNavigation;
      preview.scrollBy(direction * (action === "previewUp" || action === "previewDown" ? 1 : action === "pageUp" || action === "pageDown" ? Math.max(1, preview.height - 3) : Math.max(1, Math.floor((preview.height - 2) / 2))));
    }
  }
  function inlineKey(key: KeyEvent, state: Extract<Prompt, { kind: "inline" }>) {
    key.preventDefault();
    const action = actionForKey(bindings, key, inlineActions);
    if (action === "togglePreview") { setPreviewVisible(!preview.visible); return; }
    if (isBusy()) return;
    if (key.name === "escape") { closePrompt(); report("Cancelled."); void loadPreview(); }
    else if (action === "loadMore") void run("Loading more history…", loadMoreHistory);
    else if (action === "search") {
      destination("Choose destination", state.source, target => {
        resumeInline(state);
        void run("Loading destination…", async () => { await navigate(target); updateInlineHint(); }, true);
      }, true);
    }
    else if (action === "down") list.moveDown();
    else if (action === "up") list.moveUp();
    else if (action === "pageUp" || action === "pageDown") preview.scrollBy((action === "pageUp" ? -1 : 1) * Math.max(1, preview.height - 3));
    else if (action === "rebaseScope" && state.action.kind === "rebase") {
      state.action.descendants = !state.action.descendants;
      updateInlineHint();
    } else if (key.name === "return") {
      const destination = selected();
      if (!destination || destination.commitId === state.source.commitId) { report("Choose a different destination revision.", true); return; }
      const action: Mutation = state.action.kind === "rebase"
        ? { kind: "rebase", revision: state.source, destination, descendants: state.action.descendants }
        : { kind: "squash", revision: state.source, destination, files: [], description: destination.description };
      confirm(action);
    }
  }
  /** Keys shared by the overlay dialogs: Esc goes back, PgUp/PgDn scroll the preview, Enter submits. */
  function dialogKey(key: KeyEvent) {
    if (isBusy()) { key.preventDefault(); return; }
    if (key.name === "escape") { key.preventDefault(); goBack(); }
    else if (key.name === "pageup" || key.name === "pagedown") { key.preventDefault(); scrollPage(key, overlayPreview); }
    else if (key.name === "return") { key.preventDefault(); void submit(); }
  }
  function revsetKey(key: KeyEvent) {
    if (!isBusy() && key.name === "tab") { key.preventDefault(); completeRevset(key.shift); }
    else dialogKey(key);
  }
  function confirmKey(key: KeyEvent, state: Extract<Prompt, { kind: "confirm" }>) {
    if (!isBusy() && key.name === "escape" && state.back) { key.preventDefault(); state.back(); void loadPreview(); }
    else if (!isBusy() && key.name === "p") { key.preventDefault(); confirm(state.action); }
    else dialogKey(key);
  }
  function pickerKey(key: KeyEvent, state: Extract<Prompt, { kind: "picker" }>) {
    if (!isBusy() && pickerSearch?.handleKey(key)) return;
    key.preventDefault();
    if (isBusy()) return;
    const move = moveKey(key);
    if (key.name === "escape" || key.name === "left" || key.name === "h") goBack();
    else if (key.name === "pageup" || key.name === "pagedown") scrollPage(key, overlayPreview);
    else if (move) moveChoice(move);
    else if (key.name === "return") { const choice = state.choices[chooser.getSelectedIndex()]; if (choice && !choice.header) choice.choose(); }
  }
  function describeKey(key: KeyEvent, state: Extract<Prompt, { kind: "describe" }>) {
    if (isBusy()) { key.preventDefault(); return; }
    if (state.discard && key.name !== "escape") { state.discard = false; overlay.report(""); }
    if (key.name === "escape" && !state.discard && descriptionInput.plainText !== state.original) { key.preventDefault(); state.discard = true; report("Unsaved changes · Esc again discards · ^S saves", true); }
    else if (key.name === "escape") { key.preventDefault(); goBack(); }
    else if (key.name === "return") { key.preventDefault(); descriptionInput.newLine(); }
    else if (key.ctrl && !key.meta && (key.name === "s" || (key.name === "d" && !key.shift))) { key.preventDefault(); void submit(); }
  }
  function browseKey(key: KeyEvent) {
    if (actionForKey(bindings, key) === "togglePreview") { key.preventDefault(); setPreviewVisible(!preview.visible); return; }
    if (key.name === "escape" && previewTitle === "Last error") { key.preventDefault(); void loadPreview(); return; }
    const action = actionForKey(bindings, key);
    if (!action) return;
    if (action === "quit") { key.preventDefault(); stop(); renderer.destroy(); return; }
    if (action === "focus") { key.preventDefault(); setFocus(focus === "list" ? "preview" : "list"); return; }
    if (["down", "up", "pageUp", "pageDown"].includes(action)) {
      key.preventDefault();
      const direction = action === "up" || action === "pageUp" ? -1 : 1;
      if (action === "pageUp" || action === "pageDown") { ++previewNavigation; preview.scrollBy(direction * Math.max(1, preview.height - 3)); }
      else if (focus === "preview") { ++previewNavigation; preview.scrollBy(direction); }
      else if (direction < 0) list.moveUp(); else list.moveDown();
      return;
    }
    if (["previewUp", "previewDown", "previewHalfUp", "previewHalfDown"].includes(action)) {
      key.preventDefault();
      const direction = action === "previewUp" || action === "previewHalfUp" ? -1 : 1;
      ++previewNavigation;
      preview.scrollBy(direction * (action === "previewUp" || action === "previewDown" ? 1 : Math.max(1, Math.floor((preview.height - 2) / 2))));
      return;
    }
    if (action === "help") { key.preventDefault(); showHelp(); return; }
    if (action === "lastError") {
      key.preventDefault();
      if (!lastError) { report("No error has been reported."); return; }
      setPreviewVisible(true);
      show(`${lastError}\n\nEsc or ${bindingLabel("diff")} returns to the diff.`, "Last error");
      return;
    }
    if (action === "status") { key.preventDefault(); showStatus(); return; }
    if (isBusy()) return;
    if (action === "loadMore") { key.preventDefault(); void run("Loading more history…", loadMoreHistory); return; }
    if (action === "search") { key.preventDefault(); beginSearch(); return; }
    if (action === "nextMatch" || action === "previousMatch") { key.preventDefault(); nextMatch(action === "nextMatch" ? 1 : -1); return; }
    if (action === "return") {
      key.preventDefault();
      if (returnPoint) { const view = returnPoint; returnPoint = null; displayView(view); void loadPreview(); scheduleFocusRefresh(); }
      return;
    }
    if (action === "clearSearch") { key.preventDefault(); search = { query: "", matches: [] }; updateSearchStatus(); if (statusShown() || previewTitle === "Last error") void loadPreview(); return; }
    if (["workingCopy", "parent", "child"].includes(action)) {
      key.preventDefault(); jump(action === "workingCopy" ? "working copy" : action === "parent" ? "parent" : "child"); return;
    }
    if (action === "theme") { key.preventDefault(); pickTheme(); return; }
    if (action === "rebase" || action === "squash") {
      key.preventDefault();
      const revision = selected();
      if (revision) startInline(revision, action === "rebase" ? "rebase" : "squash");
      return;
    }
    if (action === "actions") { key.preventDefault(); const revision = selected(); if (revision) actions(revision); return; }
    if (action === "bookmarks") { key.preventDefault(); showBookmarks(); return; }
    if (action === "git") { key.preventDefault(); showRemotes(); return; }
    if (action === "operations") { key.preventDefault(); showOperations(); return; }
    if (action === "undo") { key.preventDefault(); undo(); return; }
    if (action === "files") { key.preventDefault(); const revision = selected(); if (revision) browseFiles(revision); return; }
    if (action === "absorb" || action === "abandon" || action === "split" || action === "describeExternal" || action === "evolution") {
      key.preventDefault();
      const revision = selected();
      if (!revision) { report("Select a revision first.", true); return; }
      if (action === "absorb") confirm({ kind: "absorb", revision });
      else if (action === "abandon") confirm({ kind: "abandon", revision });
      else if (action === "split") splitChange(revision);
      else if (action === "describeExternal") describeExternally(revision);
      else showEvolution(revision);
      return;
    }
    if (action === "diff") { key.preventDefault(); setPreviewVisible(true); void loadPreview(); return; }
    if (action === "refresh") { key.preventDefault(); repository.clearDiffs(); void run(null, () => refresh()); }
    else if (action === "filter") { key.preventDefault(); openPrompt({ kind: "revset" }, "Revset", revset); }
    else if (action === "describe" || action === "new" || action === "edit") {
      key.preventDefault();
      const revision = selected();
      if (!revision) { report("Select a revision first.", true); return; }
      if (action === "describe") { describe(revision); return; }
      if (action === "new") { createChild(revision); return; }
      void run("Switching working copy…", async () => {
        if (await review.prepare({ kind: "edit", revision })) await applyReviewed();
      });
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    renderer.off("palette", applyTerminalColors);
    clearInterval(refreshTimer);
    clearTimeout(resultTimer);
    clearTimeout(searchTimer);
    ++searchRequest;
    if (prompt.kind === "form") prompt.form.dispose();
    pickerSearch?.dispose();
    previews.dispose();
    review.dispose();
    renderer.off("focus", onTerminalFocus);
    renderer.off("resize", onResize);
    if (restorePreviewScroll) renderer.off("frame", restorePreviewScroll);
    renderer.keyInput.off("keypress", onKey);
    list.off("selectionChanged", onSelection);
    fileList.off("selectionChanged", onFileSelection);
    chooser.off("selectionChanged", previewChoice);
    app.destroyRecursively();
  }
  input.on("input", updateCompletions);
  input.onCursorChange = updateCompletions;
  searchInput.on("input", queueSearch);
  list.canDrag = () => !stopped && !isBusy() && prompt.kind === "browse";
  list.onRebaseDrop = (revision, destination) => confirm({ kind: "rebase", revision, destination, descendants: false });
  list.onBookmarkDrop = (name, revision) => confirm({ kind: "bookmark-move", name, revision });
  let heldMessage: [string, boolean] | null = null;
  list.onDragHint = text => {
    if (text) { heldMessage ??= [shown, shownError]; report(text); }
    else if (heldMessage) { setMessage(...heldMessage); heldMessage = null; }
  };
  app.onMouse = event => { ++activity; list.handleDragMouse(event); };
  renderer.on("focus", onTerminalFocus);
  renderer.on("resize", onResize);
  renderer.keyInput.on("keypress", onKey);
  list.on("selectionChanged", onSelection);
  fileList.on("selectionChanged", onFileSelection);
  chooser.on("selectionChanged", previewChoice);
  return { start: async () => {
    setFocus("list");
    // Palette reports arrive after startup and again when the terminal switches between light and dark.
    renderer.on("palette", applyTerminalColors);
    void renderer.getPalette().catch(() => {});
    await run("Loading history…", async () => { defaultRevset = await repository.logRevset(); await refresh(defaultRevset); });
    const interval = options.refreshIntervalMs ?? 2000;
    if (!stopped && interval > 0) { refreshTimer = setInterval(() => { void checkForUpdates(); }, interval); refreshTimer.unref(); }
  }, stop, checkForUpdates,
  // Silent refreshes leave no message to wait for, so tests wait here instead, including for a focus refresh queued as a microtask.
  async settled() { do { await Promise.resolve(); await running; } while (running); } };
}
