import { cursorBar, getTheme, hasSelectionBand, themeScrollbars, type Theme } from "../ui/theme";
import { graphChunks } from "../ui/jj-highlighting";
import { ScrollBoxRenderable, TextRenderable, StyledText, bold, fg, type RenderContext } from "@opentui/core";
import { terminalText } from "../terminal-text";
import { EllipsisText } from "../ui/ellipsis-text";
import type { ChangedFile } from "../repository/model";

const statuses: Record<string, { letter: string; color: keyof Theme }> = {
  added: { letter: "A", color: "added" },
  modified: { letter: "M", color: "bookmark" },
  removed: { letter: "D", color: "conflict" },
  renamed: { letter: "R", color: "commit" },
  copied: { letter: "C", color: "commit" },
};

/** The one-letter status the files list shows: A, M, D, R or C, or ? for a status it does not know. */
export function statusLetter(status: string) { return statuses[status]?.letter ?? "?"; }

/** The marker a marked file's row shows. */
export const markGlyph = "✓";

/** Whether `path` matches a files filter: a case-insensitive substring, with every character taken literally. */
export function matchesFilter(path: string, filter: string) {
  return !filter || path.toLowerCase().includes(filter.toLowerCase());
}

/** The files an action from the files browser acts on, and how its footer or menu text names them. */
export interface FileTargets { paths: string[]; label: string }

// A revision's changed files, expanded beneath it in the graph. Rows continue the graph's lanes, and the list
// scrolls within a height cap so a large change leaves the surrounding graph in view.
// Besides the highlighted file, the list keeps a set of marked files by path: a filter hides rows but never drops
// marks, and a reload keeps the marks on paths still in the change.
export class FileList extends ScrollBoxRenderable {
  private files: ChangedFile[] = [];
  private rows: TextRenderable[] = [];
  private empty: TextRenderable;
  private selectedIndex = 0;
  private prefix = "";
  private maxRows = 1;
  private marks = new Set<string>();
  private query = "";

  constructor(context: RenderContext, id = "changed-files") {
    super(context, { id, width: "100%", height: 1, flexShrink: 0, scrollY: true, scrollX: false, backgroundColor: getTheme(context).panel, contentOptions: { flexDirection: "column" } });
    this.empty = new EllipsisText(context, { id: `${id}-empty`, height: 1, width: "100%", flexShrink: 0, selectable: false, visible: false });
    this.add(this.empty);
    themeScrollbars(this, "panel");
  }

  applyTheme() {
    this.backgroundColor = getTheme(this.ctx).panel;
    themeScrollbars(this, "panel");
    this.paint();
  }

  /** Forgets the marks and the filter, for a list opened afresh. */
  reset() {
    this.marks.clear();
    this.query = "";
  }

  /**
   * `prefix` is the graph lanes continuing below the revision; `selectPath` keeps a file highlighted across reloads.
   * Marks on paths no longer in `files` are dropped; the result is how many were.
   */
  setFiles(files: ChangedFile[], prefix: string, maxRows: number, selectPath?: string): number {
    for (const row of this.rows) row.destroyRecursively();
    this.files = files;
    const present = new Set(files.map(file => file.path));
    const before = this.marks.size;
    this.marks = new Set([...this.marks].filter(path => present.has(path)));
    // The revision rows' three-column gutter, so the lanes line up.
    this.prefix = `   ${prefix}`;
    this.rows = files.map((_, index) => {
      const row = new EllipsisText(this.ctx, { id: `${this.id}-row-${index}`, height: 1, width: "100%", flexShrink: 0, selectable: false, onMouseDown: event => { if (event.button === 0) this.setSelectedIndex(index); } });
      this.add(row);
      return row;
    });
    const wanted = files.findIndex(file => file.path === selectPath);
    this.selectedIndex = wanted >= 0 && this.shown(wanted) ? wanted : this.firstShown();
    this.maxRows = Math.max(1, maxRows);
    this.layoutRows();
    this.scrollTo(0);
    this.revealSelected();
    return before - this.marks.size;
  }

  setMaxRows(maxRows: number) {
    this.maxRows = Math.max(1, maxRows);
    this.height = Math.max(1, Math.min(this.visibleCount, this.maxRows));
  }

  /** The text paths are filtered by; empty shows every file. */
  get filter() { return this.query; }
  /** Shows only the files whose path contains `text`, ignoring case. Marks are kept, hidden rows included. */
  setFilter(text: string) {
    if (text === this.query) return;
    const previous = this.selectedFile;
    this.query = text;
    if (!this.shown(this.selectedIndex)) this.selectedIndex = this.firstShown();
    this.layoutRows();
    this.revealSelected();
    if (this.selectedFile !== previous) this.emit("selectionChanged");
  }
  /** How many files the filter shows, and how many the change has. */
  get visibleCount() { return this.files.filter((_, index) => this.shown(index)).length; }
  get fileCount() { return this.files.length; }

  /** The marked paths, in list order, whether or not the filter shows them. */
  get markedPaths(): string[] { return this.files.filter(file => this.marks.has(file.path)).map(file => file.path); }
  isMarked(path: string) { return this.marks.has(path); }
  /** Marks the highlighted file, or unmarks it if it was marked. */
  toggleMark() {
    const file = this.selectedFile;
    if (!file) return;
    if (!this.marks.delete(file.path)) this.marks.add(file.path);
    this.paint();
  }
  /** Unmarks every file; the result is how many were marked. */
  clearMarks() {
    const count = this.marks.size;
    this.marks.clear();
    this.paint();
    return count;
  }
  /**
   * What an action from the browser acts on: the marked files when any are marked, otherwise the highlighted one. The
   * label says which ("3 selected" or "highlighted file"). Undefined when nothing is marked and the filter hides every file.
   */
  targets(): FileTargets | undefined {
    const paths = this.markedPaths;
    if (paths.length) return { paths, label: `${paths.length} selected` };
    const file = this.selectedFile;
    return file ? { paths: [file.path], label: "highlighted file" } : undefined;
  }

  private shown(index: number) {
    const file = this.files[index];
    return !!file && matchesFilter(file.path, this.query);
  }
  private firstShown() { return Math.max(0, this.files.findIndex((_, index) => this.shown(index))); }
  private layoutRows() {
    for (const [index, row] of this.rows.entries()) row.visible = this.shown(index);
    this.empty.visible = !this.visibleCount;
    this.setMaxRows(this.maxRows);
    this.paint();
  }
  private revealSelected() {
    const row = this.rows[this.selectedIndex];
    if (row?.visible) this.scrollChildIntoView(row.id);
  }

  private paint() {
    const theme = getTheme(this.ctx);
    const empty = this.files.length ? `No changed files match ${JSON.stringify(this.query)}.` : "Empty change. No changed files.";
    this.empty.content = new StyledText([...graphChunks(this.prefix, theme), fg(theme.muted)(terminalText(empty))]);
    for (const [index, file] of this.files.entries()) {
      const row = this.rows[index]!;
      const highlighted = index === this.selectedIndex;
      const status = statuses[file.status];
      const letter = status?.letter ?? (file.status[0]?.toUpperCase() || "?");
      const path = fg(theme.text)(terminalText(` ${file.path}`));
      row.content = new StyledText([...graphChunks(this.prefix, theme), bold(fg(theme.accent)(highlighted ? cursorBar(theme) : " ")),
        bold(fg(theme.accent)(this.marks.has(file.path) ? `${markGlyph} ` : "  ")), bold(fg(theme[status?.color ?? "commit"])(letter)),
        highlighted && !hasSelectionBand(theme) ? bold(path) : path]);
      row.bg = highlighted ? theme.graphSelected : theme.panel;
    }
  }

  /** The highlighted file, or undefined when the filter hides every file. */
  get selectedFile(): ChangedFile | undefined { return this.shown(this.selectedIndex) ? this.files[this.selectedIndex] : undefined; }
  getSelectedIndex() { return this.selectedIndex; }
  moveUp() { this.step(-1); }
  moveDown() { this.step(1); }
  private step(direction: -1 | 1) {
    for (let index = this.selectedIndex + direction; index >= 0 && index < this.files.length; index += direction) {
      if (this.shown(index)) { this.setSelectedIndex(index); return; }
    }
  }
  setSelectedIndex(index: number) {
    const row = this.rows[index];
    if (!row || index === this.selectedIndex || !this.shown(index)) return;
    this.selectedIndex = index;
    this.paint();
    this.scrollChildIntoView(row.id);
    this.emit("selectionChanged");
  }
}
