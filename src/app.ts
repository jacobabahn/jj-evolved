import { RevisionSearch, matchingRevisions } from "./ui/revision-search";
import { actionForKey, defaultBindings, keyLabel, type Keybindings, type Action } from "./ui/keybindings";
import { applyCompletion, revsetCompletions, type Completion } from "./revisions/revset-completion";
import { MutationReview } from "./history/mutation-review";
import { PreviewSession } from "./preview/preview-session";
import { getTheme, setTheme, themes, themeNames, themeLabels, type ThemeName, type Theme } from "./ui/theme";
import { highlightJjText, revisionPrefixes } from "./ui/jj-highlighting";
import { ChangePreview } from "./preview/change-preview";
import {
  BorderChars, BoxRenderable, InputRenderable, ScrollBoxRenderable, SelectRenderable,
  TextRenderable, TextareaRenderable, type CliRenderer, type KeyEvent,
} from "@opentui/core";
import { TreeComparisonView } from "./history/tree-comparison";
import { ActionOverlay } from "./ui/action-overlay";
import { HistoryForm } from "./history/history-form";
import { RevisionLog } from "./revisions/revision-log";
import { FileList } from "./revisions/file-list";
import { Repository } from "./repository/repository";
import { terminalText } from "./terminal-text";
import { shortChangeId, type InteractiveAction, type Mutation, type Revision, type Snapshot, type Bookmark, type ChangedFile } from "./repository/model";

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
  | { kind: "files"; revision: Revision; files: ChangedFile[] }
  | { kind: "text"; accept: (value: string) => void }
  | { kind: "confirm"; action: Mutation; edit: (() => void) | null; back: (() => void) | null };

type Search = { query: string; matches: Revision[] };
type NavigationView = { snapshot: Snapshot; bookmarks: Bookmark[]; index: number; top: number; outside: ReadonlySet<string> };

function helpText(bindings: Keybindings) {
  const row = (actions: Action[]) => actions.map(action => keyLabel(bindings, action)).join(" / ").padEnd(18);
  return `Keyboard reference

${row(["down", "up"])} Move through revisions
${row(["focus"])} Switch revisions / preview focus
${row(["togglePreview"])} Toggle preview pane
${row(["pageUp", "pageDown"])} Scroll preview by page
${row(["previewUp", "previewDown"])} Scroll preview by line, keeping graph focus
${row(["previewHalfUp", "previewHalfDown"])} Scroll preview by half page
${row(["status"])} Working-copy status
${row(["refresh"])} Refresh history
${row(["filter"])} Enter a revset; empty restores all()
${row(["search"])} Search descriptions, bookmarks and ID prefixes in revset
${row(["nextMatch", "previousMatch"])} Next / previous search match, wrapping
${row(["workingCopy", "parent", "child"])} Jump to working copy / parent / child
${row(["return"])} Return from temporary reveal
${row(["clearSearch"])} Clear accepted search
* / +             Search match / revision outside active revset
${row(["describe"])} Describe selected change in the app, including multiline
${row(["describeExternal"])} Describe selected change in JJ's configured editor
${row(["edit"])} Make selection the working copy immediately
${row(["rebase", "squash"])} Choose rebase / squash destination in the graph
${row(["split"])} Split selected files into a new first change
${row(["abandon"])} Preview abandoning the selected change
${row(["absorb"])} Preview absorb into mutable ancestors
${row(["evolution"])} Browse selected change's evolution
Drag change       Drop onto another change to preview rebase
${row(["new"])} Create an empty child of selection
${row(["actions"])} Action menu: edit, rebase, squash, split, abandon, status
${row(["bookmarks"])} Local and remote bookmarks
${row(["git"])} Git remotes: fetch and push
${row(["operations"])} Operation history, inspection and restore
${row(["undo"])} Preview undo of the latest operation
${row(["files"])} Changed files in the left pane; j/k file, Enter focus diff, h/Left/Esc return
${row(["diff"])} Show the selected revision's diff preview
${row(["theme"])} Choose a theme, preview and save
${row(["help"])} Show this help
${keyLabel(bindings, "quit")} / Ctrl-C  Quit

In prompts (fixed keys; browse overrides do not apply)
j/k or arrows     Choose an item
Enter             Apply / confirm
Shift/Alt-Enter   Newline in description
Escape            Cancel

@ marks the working copy. ! marks a conflict.
Drag a local [bookmark] onto another change to preview a move.
Escape or dropping outside the graph cancels. Use ${keyLabel(bindings, "bookmarks")} to manage remote bookmark tracking.
Tree lines show ancestry; ~ marks omitted history.
${row(["loadMore"])} Load 200 more revisions (keeps selection)
Destination lists: / searches all revisions, including older history.
Rebase destination: r moves the change only, s includes descendants.
Select a revision to return from status or help.
Commands use your installed jj and its repository rules.`; }

export function createApp(renderer: CliRenderer, repository: Repository, theme: Theme = themes.terminal, saveTheme: (name: ThemeName) => Promise<void> = async () => {}, bindings: Keybindings = defaultBindings, options: { refreshIntervalMs?: number } = {}) {
  const bindingLabel = (action: Action) => keyLabel(bindings, action);
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
  const fileList = new FileList(renderer);
  fileList.height = 0;
  fileList.flexGrow = 1;
  fileList.visible = false;
  const preview = new ScrollBoxRenderable(renderer, { id: "preview", flexGrow: 1, width: 0, minWidth: 1, border: ["top", "right", "bottom"], borderColor: colors.border, title: " Change preview ", scrollY: true, scrollX: true, contentOptions: { width: "100%", minHeight: 0 } });
  const detail = new ChangePreview(renderer, "preview-text", "Loading repository…");
  const promptLabel = new TextRenderable(renderer, { id: "prompt-label", height: 1, visible: false, fg: colors.accent });
  const input = new InputRenderable(renderer, { id: "prompt-input", visible: false, width: "100%", textColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.panel, focusedTextColor: colors.text, placeholderColor: colors.muted });
  const descriptionInput = new TextareaRenderable(renderer, { id: "description-input", visible: false, width: "100%", height: 0, flexGrow: 1, minHeight: 1, wrapMode: "word", textColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.panel, focusedTextColor: colors.text });
  const searchInput = new InputRenderable(renderer, { id: "search-input", visible: false, width: "100%", placeholder: "Search active revset", textColor: colors.text, focusedTextColor: colors.text, backgroundColor: colors.panel, focusedBackgroundColor: colors.panel });
  const searchStatus = new TextRenderable(renderer, { id: "search-status", visible: false, height: 1, wrapMode: "none", truncate: true, fg: colors.accent });
  const navigationStatus = new TextRenderable(renderer, { id: "navigation-status", visible: false, height: 1, fg: colors.accent, content: `temporary view (up to 40) | + outside filter | ${bindingLabel("return")} return` });
  const message = new TextRenderable(renderer, { id: "message", height: 1, fg: colors.muted, content: "Loading history…" });
  const inlineHint = new TextRenderable(renderer, { id: "inline-action", height: 3, flexShrink: 0, visible: false, fg: colors.accent });
  const browseShortcuts = `${keyLabel(bindings, "down", true)}/${keyLabel(bindings, "up", true)} move  ${bindingLabel("filter")} revset  ${bindingLabel("search")} search  ${bindingLabel("nextMatch")}/${bindingLabel("previousMatch")} match  ${bindingLabel("workingCopy")} work  ${bindingLabel("parent")}/${bindingLabel("child")} ancestry  ${bindingLabel("return")} return\n${bindingLabel("diff")} diff  ${bindingLabel("describe")} describe  ${bindingLabel("rebase")}/${bindingLabel("squash")} rebase/squash  ${bindingLabel("actions")} actions  ${bindingLabel("help")} help  ${bindingLabel("quit")} quit`;
  const filesShortcuts = `${keyLabel(bindings, "down", true)}/${keyLabel(bindings, "up", true)} file  Enter focus diff  ${bindingLabel("focus")} focus  ${bindingLabel("togglePreview")} preview  ${bindingLabel("pageUp")}/${bindingLabel("pageDown")} scroll\nh/Left/Esc/${bindingLabel("files")} back to revisions  ${bindingLabel("quit")} quit`;
  const shortcuts = new TextRenderable(renderer, { id: "shortcuts", height: 2, fg: colors.accent, content: browseShortcuts });
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
  overlay.body.add(descriptionInput);
  const suggestions = new TextRenderable(renderer, { id: "revset-suggestions", visible: false, height: 5, fg: colors.text, wrapMode: "none", truncate: true });
  overlay.body.add(suggestions);
  overlay.body.add(chooser);
  overlay.body.add(overlayPreview);
  const result = new TextRenderable(renderer, { id: "action-result", height: 2, visible: false, fg: colors.accent });
  listBox.add(result);
  listBox.add(list);
  listBox.add(fileList);
  preview.add(detail);
  body.add(listBox);
  body.add(preview);
  for (const child of [header, filter, message, navigationStatus, searchInput, searchStatus, inlineHint, body, shortcuts, overlay]) app.add(child);
  renderer.root.add(app);

  let resultTimer: ReturnType<typeof setTimeout> | undefined;
  let revisions: Revision[] = [];
  let historyLimit = 200;
  let refreshRequest = 0;
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
  let destinationSearch: RevisionSearch | null = null;
  let prompt: Prompt = { kind: "browse" };
  let completionItems: Completion[] = [];
  let completionOriginal = "";
  let completionIndex = -1;
  let completing = false;
  let busy = false;
  let stopped = false;
  let activity = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let checkingUpdates = false;
  let observedOperation: string | null = null;
  let refreshError = "";
  let replacing = false;
  let focusRefreshPending = false;
  let previewNavigation = 0;
  let restorePreviewScroll: (() => void) | undefined;
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
    if (!preview.visible) next = "list";
    focus = next;
    listBox.borderColor = next === "list" ? colors.accent : colors.border;
    preview.borderColor = next === "preview" ? colors.accent : colors.border;
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
    message.content = "";
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
  async function loadPreview() {
    ++previewNavigation;
    if (restorePreviewScroll) renderer.off("frame", restorePreviewScroll);
    restorePreviewScroll = undefined;
    const revision = selected();
    if (!revision) { show(`No revisions match this revset. Press ${bindingLabel("filter")} to change it.`, "No revisions"); return; }
    const metadata = terminalText(`${revision.description.trimEnd() || "(no description)"}\n\nChange   ${revision.changeId}\nCommit   ${revision.commitId}\nAuthor   ${revision.author}\nBookmarks ${revision.bookmarks || "none"}\nParents  ${revision.parents.map(id => id.slice(0, 12)).join(", ") || "none"}\n${revision.workingCopy ? "Working copy  " : ""}${revision.conflict ? `CONFLICT\n${bindingLabel("actions")} → Resolve conflicts opens your configured merge tool.` : ""}`.trimEnd() + "\n\n");
    await previews.load({ target: "main", title: "Change preview", loading: "Loading diff…",
      prefix: metadata, read: () => repository.diff(revision), empty: "Empty change. No file differences." });
  }
  function errorText(error: unknown) { return terminalText(error instanceof Error ? error.message : String(error)); }
  async function refresh(nextRevset = revset, workingCopy = false, preserveView = false) {
    ++activity;
    focusRefreshPending = false;
    const request = ++refreshRequest;
    const limit = nextRevset === revset ? historyLimit : 200;
    const query = preserveView ? search.query : "";
    list.cancelDrag();
    const snapshot = await repository.snapshot(nextRevset, false, limit);
    const bookmarks = await repository.bookmarks();
    const candidates = query ? await repository.navigationRevisions(nextRevset) : [];
    if (stopped || request !== refreshRequest) return;
    // Browsing stays available during reads; preserve the latest view when applying results.
    const previous = selected();
    const top = list.scrollTop;
    const previewTop = preview.scrollTop;
    const helpVisible = preserveView && String(preview.title).trim() === "Help";
    const statusVisible = preserveView && String(preview.title).trim() === "Working-copy status";
    historyLimit = limit;
    ++searchRequest;
    clearTimeout(searchTimer);
    const needle = query.toLowerCase();
    const bookmarkIds = new Set(bookmarks.filter(item => `${item.name}${item.remote ? `@${item.remote}` : ""}`.toLowerCase().includes(needle)).flatMap(item => item.targets));
    search = { query, matches: candidates.filter(item => item.description.toLowerCase().includes(needle) || item.changeId.startsWith(needle) || item.commitId.startsWith(needle) || bookmarkIds.has(item.commitId)) };
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
      ? previews.load({ target: "main", title: "Working-copy status", loading: "Loading status…", read: () => repository.status(), errorTitle: "Status error" })
      : !helpVisible ? loadPreview() : undefined;
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
    focusRefreshPending = true;
    if (prompt.kind !== "browse" && !review.applying) {
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
      if (stopped || !focusRefreshPending || isBusy() || prompt.kind !== "browse") return;
      if (returnPoint) {
        report(`Focus refresh pending: ${bindingLabel("return")} returns to the active revset and refreshes.`);
        return;
      }
      void run("Refreshing after terminal focus…", () => refresh(revset, false, true));
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
    const snapshot = await repository.snapshot(revset, false, limit);
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
    if (stopped || checkingUpdates || isBusy() || prompt.kind !== "browse" || list.dragActive) return;
    checkingUpdates = true;
    const generation = activity;
    const valid = () => !stopped && activity === generation && !isBusy() && prompt.kind === "browse" && !list.dragActive;
    try {
      // status snapshots pending file edits, including edits made without a JJ command.
      const status = await repository.status();
      const operation = await repository.operationId();
      if (!valid()) return;
      if (operation === observedOperation) {
        if (refreshError) { report(`Ready. ${bindingLabel("help")} shows all controls.`); refreshError = ""; }
        return;
      }
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
      if (refreshError) report(`Ready. ${bindingLabel("help")} shows all controls.`);
      refreshError = "";
      const previewTop = preview.scrollTop;
      const previewTitle = preview.title;
      if (search.query) search = { query: search.query, matches: matchingRevisions(candidates, bookmarks, search.query) };
      returnPoint = restoredReturn;
      displayView(view);
      if (previewTitle?.includes("Working-copy status")) show(status, "Working-copy status");
      else if (!previewTitle?.includes("Help") && JSON.stringify(previous) !== JSON.stringify(selected())) await loadPreview();
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
    try { await action(); report(`Ready. ${bindingLabel("help")} shows all controls.`); }
    catch (error) {
      if (prompt.kind === "confirm" && prompt.edit) prompt.edit();
      report(errorText(error), true);
    }
    finally { busy = false; scheduleFocusRefresh(); }
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
  function closePrompt() {
    destinationSearch?.dispose();
    destinationSearch = null;
    suggestions.visible = false;
    if (prompt.kind === "form") prompt.form.dispose();
    prompt = { kind: "browse" };
    review.cancel();
    previews.cancel();
    overlay.visible = false;
    inlineHint.visible = false;
    list.markSource(null);
    list.mouseSelectionEnabled = true;
    input.blur();
    descriptionInput.blur();
    descriptionInput.visible = false;
    chooser.blur();
    chooser.visible = false;
    fileList.blur();
    fileList.visible = false;
    list.visible = true;
    listBox.title = " Revisions ";
    shortcuts.content = browseShortcuts;
    input.visible = false;
    promptLabel.visible = false;
    setFocus(focus);
    scheduleFocusRefresh();
  }
  function openPrompt(next: Exclude<Prompt, { kind: "browse" }>, label: string, value = "") {
    activateOverlay(label);
    chooser.visible = false;
    prompt = next;
    suggestions.visible = false;
    if (next.kind === "describe" || next.kind === "revset" || next.kind === "text") {
      overlay.height = 12;
      overlay.top = "20%";
      overlayPreview.visible = false;
    }
    if (next.kind === "describe" || next.kind === "new" || next.kind === "revset" || next.kind === "text") showOverlay(label, "Action");
    promptLabel.content = terminalText(`${label}  [Enter apply · Esc cancel]`);
    promptLabel.visible = true;
    input.placeholder = "";
    input.value = terminalText(value);
    descriptionInput.visible = next.kind === "describe";
    input.visible = next.kind !== "new" && next.kind !== "confirm" && next.kind !== "describe";
    if (!input.visible) { list.blur(); preview.blur(); } else input.focus();
    if (next.kind === "describe") {
      overlay.height = "65%";
      overlay.body.marginBottom = 0;
      overlay.top = "12%";
      descriptionInput.setText(terminalText(value));
      descriptionInput.gotoBufferEnd();
      descriptionInput.focus();
      overlay.hints.content = "Enter save · Shift/Alt+Enter newline · Esc cancel";
    }
    if (next.kind === "revset") {
      overlay.height = 15;
      overlay.hints.content = "Tab complete/cycle  Enter apply  Esc cancel";
      updateCompletions();
    }
    if (next.kind === "confirm") overlay.hints.content = "Enter apply  p refresh preview  Esc cancel  PgUp/Dn scroll";
  }
  async function submit() {
    if (isBusy()) return;
    const current = prompt;
    const value = current.kind === "describe" ? descriptionInput.plainText : input.value;
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
    suggestions.fg = colors.text;
    header.fg = navigationStatus.fg = searchStatus.fg = promptLabel.fg = inlineHint.fg = shortcuts.fg = result.fg = colors.accent;
    filter.fg = message.fg = colors.muted;
    listBox.backgroundColor = colors.panel;
    listBox.borderColor = focus === "list" ? colors.accent : colors.border;
    preview.borderColor = focus === "preview" ? colors.accent : colors.border;
    overlayPreview.borderColor = colors.border;
    input.backgroundColor = input.focusedBackgroundColor = colors.panel;
    input.textColor = input.focusedTextColor = colors.text;
    input.placeholderColor = colors.muted;
    descriptionInput.backgroundColor = descriptionInput.focusedBackgroundColor = colors.panel;
    descriptionInput.textColor = descriptionInput.focusedTextColor = colors.text;
    searchInput.backgroundColor = searchInput.focusedBackgroundColor = colors.panel;
    searchInput.textColor = searchInput.focusedTextColor = colors.text;
    searchInput.placeholderColor = colors.muted;
    chooser.backgroundColor = chooser.focusedBackgroundColor = colors.panel;
    chooser.textColor = chooser.focusedTextColor = colors.text;
    chooser.descriptionColor = colors.muted;
    chooser.selectedBackgroundColor = colors.selected;
    chooser.selectedTextColor = chooser.selectedDescriptionColor = colors.selectedText;
    list.applyTheme();
    fileList.applyTheme();
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
  function destination(title: string, source: Revision | null, accept: (revision: Revision) => void, searchImmediately = false) {
    void run("Loading destinations…", async () => {
      const [candidates, bookmarks] = await Promise.all([repository.navigationRevisions("all()"), repository.bookmarks()]);
      if (stopped) return;
      const revisions = candidates.filter(item => item.commitId !== source?.commitId);
      overlayText.prefixes = revisionPrefixes(revisions);
      const choices = (items: Revision[]): Choice[] => items.map(item => ({
        name: `${item.changeId.slice(0, 8)} ${item.description.split("\n")[0] || "(no description)"}`,
        description: `${item.commitId.slice(0, 12)} ${item.bookmarks}`,
        choose: () => { destinationSearch?.dispose(); destinationSearch = null; accept(item); },
        preview: () => repository.diff(item),
      }));
      pick(title, choices(revisions));
      destinationSearch = new RevisionSearch(renderer, "destination-search", chooser, revisions, bookmarks, matches => {
        if (prompt.kind !== "picker") return;
        prompt.choices = choices(matches);
        chooser.options = prompt.choices.map(choice => ({ name: terminalText(choice.name), description: terminalText(choice.description) }));
        chooser.setSelectedIndex(0);
        if (matches.length) previewChoice();
        else showOverlay("No matching destinations. Edit the search or press Escape to clear it.", "Destinations");
        overlay.report(`${matches.length} destinations`);
      });
      overlay.fields.add(destinationSearch.input);
      if (searchImmediately) destinationSearch.start();
      overlay.hints.content = "j/k choose · / search all destinations · Enter select · Esc back";
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
      closePrompt();
      prompt = { kind: "files", revision, files };
      list.mouseSelectionEnabled = false;
      list.blur();
      list.visible = false;
      fileList.visible = true;
      fileList.setFiles(files);
      updateFilesTitle();
      shortcuts.content = filesShortcuts;
      setFocus("list");
      if (files.length) void loadFilePreview(); else show("Empty change. No changed files.", "Changed files");
    });
  }
  function fitTitle(text: string, width: number, keepEnd = false) {
    text = terminalText(text).replace(/\n/g, " ");
    const max = Math.max(6, width - 6);
    return text.length <= max ? text : keepEnd ? `…${text.slice(text.length - max + 1)}` : `${text.slice(0, max - 1)}…`;
  }
  function paneWidth(total = renderer.width) { return preview.visible ? Math.max(26, Math.floor(total * 0.42)) : total; }
  function updateFilesTitle(total?: number) {
    if (prompt.kind !== "files") return;
    const { revision } = prompt;
    listBox.title = ` ${fitTitle(`Files · ${revision.changeId.slice(0, 8)} ${revision.description.split("\n")[0] || "(no description)"}`, paneWidth(total))} `;
  }
  async function loadFilePreview() {
    if (prompt.kind !== "files") return;
    const { revision } = prompt;
    const file = fileList.selectedFile;
    if (!file) return;
    ++previewNavigation;
    await previews.load({ target: "main", title: fitTitle(file.path, renderer.width - paneWidth(), true), loading: "Loading diff…", read: () => repository.diff(revision, [file.path]), empty: `No differences in ${file.path}.` });
  }
  function closeFiles() {
    if (prompt.kind !== "files") return;
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
            });
          } },
        ]),
      })));
    });
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
        try { await applyReviewed(); report(`Ready. ${bindingLabel("help")} shows all controls.`); }
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
    openPrompt({ kind: "describe", revision }, `Describe ${revision.changeId.slice(0, 8)}`, revision.description.replace(/\n$/, ""));
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
        await refresh(preserveSelection ? revset : "all()", !preserveSelection).catch(error => {
          throw new Error(`Refreshing after ${name} failed. Press ${bindingLabel("refresh")} to reload before repeating the action. ${errorText(error)}`);
        });
      }
    });
  }

  function actions(revision: Revision) {
    pick("Actions", [
      { name: "Edit change", description: "Make selection the working copy", choose: () => confirm({ kind: "edit", revision }) },
      { name: "Describe change", description: `Edit the selected change's description (${bindingLabel("describe")})`, choose: () => describe(revision) },
      { name: "Edit description in editor", description: `Edit the full multiline description in JJ's configured editor (${bindingLabel("describeExternal")})`, choose: () => describeExternally(revision) },
      ...(revision.conflict ? [{ name: "Resolve conflicts", description: "Open JJ's configured merge tool for this change", choose: () => editInteractively({ kind: "resolve", revision }) }] : []),
      { name: "Rebase change", description: `Source, destination, scope and preview (${bindingLabel("rebase")} for inline)`, choose: () => openHistory(revision, "rebase", false) },
      { name: "Rebase change and descendants", description: "Move the selected stack", choose: () => openHistory(revision, "rebase", true) },
      { name: "Squash changes", description: "Source, destination, files and description", choose: () => openHistory(revision, "squash") },
      { name: "Squash interactively", description: "Choose files or hunks in JJ's configured diff editor", choose: () => destination("Squash interactively into", revision, destination => editInteractively({ kind: "squash", revision, destination })) },
      { name: "Split interactively", description: "Choose files or hunks in JJ's configured diff editor", choose: () => editInteractively({ kind: "split", revision }) },
      { name: "Split change", description: `Put selected files in a first change (${bindingLabel("split")})`, choose: () => splitChange(revision) },
      { name: "Git remotes", description: `Fetch, push and select a remote (${bindingLabel("git")})`, choose: showRemotes },
      { name: "Create bookmark", description: "Name the selected revision", choose: () => ask("Bookmark name", "", name => confirm({ kind: "bookmark-create", name, revision })) },
      { name: "Abandon change", description: `Remove selection and rebase its descendants (${bindingLabel("abandon")})`, choose: () => confirm({ kind: "abandon", revision }) },
      { name: "Browse changed files", description: "Preview one file at a time", choose: () => browseFiles(revision) },
      { name: "Open in Hunk", description: "Review the selected change in the external Hunk viewer", choose: () => openExternal("Hunk", () => repository.openHunk(revision)) },
      { name: "Absorb into ancestors", description: `Preview automatic fixups into mutable ancestors (${bindingLabel("absorb")})`, choose: () => confirm({ kind: "absorb", revision }) },
      { name: "Change evolution", description: `Browse previous versions and their rewrite diffs (${bindingLabel("evolution")})`, choose: () => showEvolution(revision) },
      { name: "Working-copy status", description: `Show jj status in the preview (${bindingLabel("status")})`, choose: () => { closePrompt(); showStatus(); } },
      { name: "Load more revisions", description: `Load 200 more revisions, keeping selection (${bindingLabel("loadMore")})`, choose: () => { closePrompt(); void run("Loading more history…", loadMoreHistory); } },
    ]);
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
      read: () => repository.status(), errorTitle: "Status error" });
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
      ? `${prompt.action.descendants ? `Change and descendants: ${moving.length} changes` : "Selected change only"}${outside ? ` · ${outside} outside view` : ""} · r change · s descendants`
      : "All files · Keep destination description";
    inlineHint.content = terminalText(`${prompt.action.kind === "rebase" ? "Rebase" : "Squash"} from ● ${prompt.source.changeId.slice(0, 8)} → ${destination?.changeId.slice(0, 8) || "Choose destination"}\n${scope}\n● will move · j/k destination · / search · ${bindingLabel("loadMore")} load more · Enter preview · Esc cancel`);
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
      ++activity;
      updateInlineHint();
      updateSearchStatus();
      void loadPreview();
    }
  }
  function onFileSelection() {
    if (prompt.kind !== "files") return;
    ++activity;
    void loadFilePreview();
  }
  function onResize(width: number) { updateFilesTitle(width); }
  function onKey(key: KeyEvent) {
    if (stopped) return;
    ++activity;
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
    if ((((prompt.kind === "browse" || prompt.kind === "files") && actionForKey(bindings, key) === "togglePreview") || (prompt.kind === "inline" && key.name === "p" && !key.ctrl && !key.meta && !key.shift))) {
      key.preventDefault();
      setPreviewVisible(!preview.visible);
      return;
    }
    if (prompt.kind === "files") {
      const action = actionForKey(bindings, key);
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
      return;
    }
    if (prompt.kind === "inline") {
      key.preventDefault();
      if (isBusy()) return;
      if (key.name === "escape") { closePrompt(); report("Cancelled."); void loadPreview(); }
      else if (actionForKey(bindings, key) === "loadMore") void run("Loading more history…", loadMoreHistory);
      else if (key.name === "/" || key.sequence === "/") {
        const state = prompt;
        destination("Choose destination", state.source, target => {
          closePrompt();
          prompt = state;
          inlineHint.visible = true;
          void run("Loading destination…", async () => { await navigate(target); updateInlineHint(); });
        }, true);
      }
      else if (key.name === "j" || key.name === "down") list.moveDown();
      else if (key.name === "k" || key.name === "up") list.moveUp();
      else if (key.name === "pageup" || key.name === "pagedown") preview.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, preview.height - 3));
      else if ((key.name === "r" || key.name === "s") && !key.shift && prompt.action.kind === "rebase") {
        prompt.action.descendants = key.name === "s";
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
      if (!isBusy() && prompt.kind === "picker" && destinationSearch?.handleKey(key)) return;
      if (isBusy()) { key.preventDefault(); return; }
      if (key.name === "escape" || (prompt.kind === "picker" && (key.name === "left" || key.name === "h"))) { key.preventDefault(); if (prompt.kind === "confirm" && prompt.back) prompt.back(); else closePrompt(); void loadPreview(); }
      else if (prompt.kind === "describe" && key.name === "return" && (key.shift || key.meta)) { key.preventDefault(); descriptionInput.newLine(); }
      else if (prompt.kind !== "describe" && (key.name === "pageup" || key.name === "pagedown")) { key.preventDefault(); overlayPreview.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, overlayPreview.height - 3)); }
      else if (prompt.kind === "picker") {
        key.preventDefault();
        if (isBusy()) return;
        if (key.name === "j" || key.name === "down") chooser.moveDown();
        else if (key.name === "k" || key.name === "up") chooser.moveUp();
        else if (key.name === "return") { const choice = prompt.choices[chooser.getSelectedIndex()]; choice?.choose(); }
      }
      else if (prompt.kind === "confirm" && key.name === "p") { key.preventDefault(); confirm(prompt.action); }
      else if (prompt.kind === "revset" && key.name === "tab") { key.preventDefault(); completeRevset(key.shift); }
      else if (key.name === "return") { key.preventDefault(); void submit(); }
      return;
    }
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
    if (action === "help") { key.preventDefault(); setPreviewVisible(true); show(helpText(bindings), "Help"); return; }
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
    if (action === "clearSearch") { key.preventDefault(); search = { query: "", matches: [] }; updateSearchStatus(); return; }
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
    if (action === "refresh") { key.preventDefault(); void run("Refreshing history…", () => refresh()); }
    else if (action === "filter") { key.preventDefault(); openPrompt({ kind: "revset" }, "Revset", revset); }
    else if (action === "describe" || action === "new" || action === "edit") {
      key.preventDefault();
      const revision = selected();
      if (!revision) { report("Select a revision first.", true); return; }
      if (action === "edit") void run("Switching working copy…", async () => {
        if (await review.prepare({ kind: "edit", revision })) await applyReviewed();
      });
      else if (action === "new") openPrompt({ kind: "new", parent: revision }, `Create child of ${revision.changeId.slice(0, 8)}?`);
      else describe(revision);
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(refreshTimer);
    clearTimeout(resultTimer);
    clearTimeout(searchTimer);
    ++searchRequest;
    if (prompt.kind === "form") prompt.form.dispose();
    destinationSearch?.dispose();
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
  list.onDragHint = text => report(text || `Ready. ${bindingLabel("help")} shows all controls.`);
  app.onMouse = event => { ++activity; list.handleDragMouse(event); };
  renderer.on("focus", onTerminalFocus);
  renderer.on("resize", onResize);
  renderer.keyInput.on("keypress", onKey);
  list.on("selectionChanged", onSelection);
  fileList.on("selectionChanged", onFileSelection);
  chooser.on("selectionChanged", previewChoice);
  return { start: async () => {
    setFocus("list");
    await run("Loading history…", () => refresh());
    const interval = options.refreshIntervalMs ?? 2000;
    if (!stopped && interval > 0) { refreshTimer = setInterval(() => { void checkForUpdates(); }, interval); refreshTimer.unref(); }
  }, stop, checkForUpdates };
}
