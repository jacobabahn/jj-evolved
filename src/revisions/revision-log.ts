import { getTheme } from "../ui/theme";
import { changeIdChunks, graphChunks } from "../ui/jj-highlighting";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, StyledText, bold, fg, bg, type MouseEvent, type RenderContext, type Renderable } from "@opentui/core";
import { terminalText } from "../terminal-text";
import { shortChangeId, type Bookmark, type GraphRow, type Revision, type Snapshot } from "../repository/model";


// Rows are pooled across snapshots: a refresh updates them in place and recreates only badges and conflict markers.
// Setting row text is the expensive part, so only rows near the viewport are painted; the rest paint as they scroll in.
type Row = { position: number; node: BoxRenderable; label: TextRenderable; bookmarkPreview: TextRenderable | null; badges: TextRenderable[]; extras: Renderable[]; revisionIndex: number | null; heading: boolean; graph: GraphRow | null; text: { plain: StyledText; drag: StyledText } | null };
type BookmarkSource = { bookmark: Bookmark; revision: Revision };
type DragSource = ({ action: "bookmark" } & BookmarkSource) | { action: "rebase"; revision: Revision };
type Drag = DragSource & { kind: "pressed" | "dragging" };
const changedIds = (before: ReadonlySet<string>, after: ReadonlySet<string>) =>
  [...before].filter(id => !after.has(id)).concat([...after].filter(id => !before.has(id)));

export class RevisionLog extends ScrollBoxRenderable {
  mouseSelectionEnabled = true;
  canDrag = () => false;
  onRebaseDrop = (_source: Revision, _destination: Revision) => {};
  onBookmarkDrop = (_name: string, _revision: Revision) => {};
  onDragHint = (_text: string) => {};
  private snapshot: { data: Snapshot; bookmarks: Bookmark[] } | null = null;
  private selectedIndex = 0;
  private searchMatches: ReadonlySet<string> = new Set();
  private outsideFilter: ReadonlySet<string> = new Set();

  markNavigation(matches: ReadonlySet<string>, outside: ReadonlySet<string>) {
    const changed = [...changedIds(this.searchMatches, matches), ...changedIds(this.outsideFilter, outside)];
    this.searchMatches = matches;
    this.outsideFilter = outside;
    this.paintSelection(changed.map(id => this.revisionIndexes.get(id)));
  }
  private revisions: Revision[] = [];
  private sourceIndex: number | null = null;
  private movingCommits: ReadonlySet<string> = new Set();
  private rows: Row[] = [];
  private stale = new Set<Row>();
  private revisionRows: Row[][] = [];
  private revisionIndexes = new Map<string, number>();
  private bookmarkSources = new Map<Renderable, BookmarkSource>();
  private revisionSources = new Map<Renderable, Revision>();
  private drag: Drag | null = null;
  get dragActive() { return this.drag !== null; }
  private dropIndex: number | null = null;
  private expansion: { commitId: string; child: Renderable } | null = null;

  constructor(context: RenderContext) {
    super(context, {
      id: "revisions", width: "100%", height: "100%", scrollY: true, scrollX: false,
      backgroundColor: getTheme(context).panel, contentOptions: { flexDirection: "column" },
    });
  }

  applyTheme() {
    this.backgroundColor = getTheme(this.ctx).panel;
    if (this.snapshot) {
      const top = this.scrollTop;
      this.setSnapshot(this.snapshot.data, this.snapshot.bookmarks);
      this.scrollTop = top;
    }
  }

  setSnapshot(snapshot: Snapshot, bookmarks: Bookmark[]) {
    this.snapshot = { data: snapshot, bookmarks };
    this.cancelDrag();
    const theme = getTheme(this.ctx);
    for (const row of this.rows.splice(snapshot.graph.length)) { this.stale.delete(row); row.node.destroyRecursively(); }
    this.revisionRows = snapshot.revisions.map(() => []);
    this.revisionIndexes = new Map(snapshot.revisions.map((revision, index) => [revision.commitId, index]));
    this.bookmarkSources.clear();
    this.revisionSources.clear();
    this.revisions = snapshot.revisions;
    for (const [rowIndex, row] of snapshot.graph.entries()) {
      const revision = row.kind === "edge" ? null : row.revision;
      const revisionIndex = revision ? this.revisionIndexes.get(revision.commitId) ?? null : null;
      const heading = row.kind === "revision";
      const painted = this.rows[rowIndex] ?? this.createRow(rowIndex);
      for (const extra of painted.extras) extra.destroyRecursively();
      Object.assign(painted, { revisionIndex, heading, graph: row, text: null, badges: [], extras: [] });
      painted.label.flexShrink = heading ? 0 : 1;
      if (painted.bookmarkPreview) painted.bookmarkPreview.fg = theme.bookmark;
      if (revision) this.revisionSources.set(painted.label, revision);
      if (heading && revision) {
        for (const [index, bookmark] of bookmarks.filter(item => item.targets.includes(revision.commitId)).entries()) {
          const badge = new TextRenderable(this.ctx, {
            id: `bookmark-${rowIndex}-${index}`, height: 1, marginLeft: 1, flexShrink: 0, selectable: false, wrapMode: "none",
            content: terminalText(`[${bookmark.name}${bookmark.remote ? `@${bookmark.remote}` : ""}${bookmark.conflict ? "!" : ""}]`),
          });
          painted.node.add(badge);
          painted.badges.push(badge);
          painted.extras.push(badge);
          if (!bookmark.remote) this.bookmarkSources.set(badge, { bookmark, revision });
        }
        if (revision.conflict) {
          const marker = new TextRenderable(this.ctx, { height: 1, flexShrink: 0, selectable: false, content: " ! conflict", fg: theme.conflict });
          painted.node.add(marker);
          painted.extras.push(marker);
        }
      }
      if (revisionIndex !== null) this.revisionRows[revisionIndex]?.push(painted);
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.revisions.length - 1));
    this.paintSelection();
    if (this.expansion) this.placeExpansion();
  }

  private createRow(rowIndex: number): Row {
    const row: Row = {
      position: rowIndex,
      node: new BoxRenderable(this.ctx, {
        id: `revision-row-${rowIndex}`, height: 1, width: "100%", flexShrink: 0,
        flexDirection: "row", overflow: "hidden",
        onMouseDown: event => {
          if (event.button === 0 && this.mouseSelectionEnabled && row.revisionIndex !== null &&
            (!event.target || !this.bookmarkSources.has(event.target))) this.setSelectedIndex(row.revisionIndex);
        },
      }),
      label: new TextRenderable(this.ctx, { id: `revision-label-${rowIndex}`, height: 1, wrapMode: "none", truncate: true, selectable: false }),
      bookmarkPreview: null,
      badges: [], extras: [], revisionIndex: null, heading: false, graph: null, text: null,
    };
    row.node.add(row.label);
    this.add(row.node);
    this.rows.push(row);
    return row;
  }

  // Shows a renderable beneath a revision's rows, in the graph, until collapsed; false when the revision is not loaded.
  expand(index: number, child: Renderable) {
    const revision = this.revisions[index];
    if (!revision) return false;
    this.collapse();
    this.expansion = { commitId: revision.commitId, child };
    if (!this.placeExpansion()) return false;
    this.paintSelection([index]);
    return true;
  }

  collapse() {
    if (!this.expansion) return;
    const index = this.revisionIndexes.get(this.expansion.commitId);
    if (this.expansion.child.parent) this.remove(this.expansion.child);
    this.expansion = null;
    this.paintSelection([index]);
  }

  // The graph lanes that continue below the revision, so expanded rows keep the graph's lines unbroken.
  continuationPrefix(index: number) {
    const row = this.snapshot?.data.graph.findLast(row => row.kind !== "edge" && row.revision === this.revisions[index]);
    if (!row || row.kind === "edge") return "";
    return row.kind === "description" ? row.prefix : row.prefix.replace(/[^\s│]/gu, " ");
  }

  private placeExpansion() {
    const expansion = this.expansion!;
    const index = this.revisionIndexes.get(expansion.commitId);
    const last = index === undefined ? undefined : this.revisionRows[index]?.at(-1);
    if (expansion.child.parent) this.remove(expansion.child);
    if (!last) { this.expansion = null; return false; }
    this.add(expansion.child, this.rows.indexOf(last) + 1);
    return true;
  }

  handleDragMouse(event: MouseEvent) {
    if (event.type === "down") {
      this.cancelDrag();
      const bookmark = event.target ? this.bookmarkSources.get(event.target) : undefined;
      const revision = event.target ? this.revisionSources.get(event.target) : undefined;
      const source: DragSource | null = bookmark ? { action: "bookmark", ...bookmark } : revision ? { action: "rebase", revision } : null;
      if (event.button === 0 && source && this.canDrag()) {
        this.drag = { kind: "pressed", ...source };
        event.preventDefault();
      }
      return;
    }
    if (!this.drag) return;
    if (!this.canDrag()) { this.cancelDrag(); return; }
    if (event.type === "drag" && event.button === 0) {
      const previousDrop = this.dropIndex, started = this.drag.kind === "pressed";
      this.drag.kind = "dragging";
      this.dropIndex = this.destinationAt(event.x, event.y);
      const destination = this.dropIndex === null ? null : this.revisions[this.dropIndex];
      const operation = this.drag.action === "bookmark" ? `Move ${this.drag.bookmark.name}` : `Rebase ${this.drag.revision.changeId.slice(0, 8)} (only this change)`;
      this.onDragHint(`${operation} → ${destination?.changeId.slice(0, 8) || "choose another change"} · release to preview · Esc cancel`);
      this.paintSelection([previousDrop, this.dropIndex, ...started ? this.dragIndexes(this.drag) : []]);
    } else if (event.type === "up" && event.button === 0) {
      const drag = this.drag;
      const index = this.destinationAt(event.x, event.y);
      const destination = index === null ? null : this.revisions[index];
      this.cancelDrag();
      if (drag.kind === "dragging" && destination) {
        if (drag.action === "bookmark") this.onBookmarkDrop(drag.bookmark.name, destination);
        else this.onRebaseDrop(drag.revision, destination);
      }
    }
  }

  cancelDrag() {
    if (!this.drag) return;
    const wasDragging = this.drag.kind === "dragging", dropIndex = this.dropIndex;
    const sources = this.dragIndexes(this.drag);
    this.drag = null;
    this.dropIndex = null;
    if (wasDragging) { this.paintSelection([dropIndex, ...sources]); this.onDragHint(""); }
  }

  // A conflicted bookmark's badge appears on every row it targets, and all of them highlight while it is dragged.
  private dragIndexes(drag: Drag) {
    return [drag.revision.commitId, ...(drag.action === "bookmark" ? drag.bookmark.targets : [])].map(id => this.revisionIndexes.get(id));
  }

  private destinationAt(x: number, y: number): number | null {
    const viewport = this.viewport;
    if (x < viewport.x || x >= viewport.x + viewport.width || y < viewport.y || y >= viewport.y + viewport.height) return null;
    const row = this.rows.find(row => y >= row.node.y && y < row.node.y + row.node.height);
    if (row?.revisionIndex === null || row?.revisionIndex === undefined) return null;
    if (this.revisions[row.revisionIndex]?.commitId === this.drag?.revision.commitId) return null;
    return row.revisionIndex;
  }

  getSelectedIndex() { return this.selectedIndex; }
  markSource(index: number | null, movingCommits: ReadonlySet<string> = new Set()) {
    const changed = [this.sourceIndex, index, ...changedIds(this.movingCommits, movingCommits).map(id => this.revisionIndexes.get(id))];
    this.sourceIndex = index;
    this.movingCommits = movingCommits;
    this.paintSelection(changed);
  }
  moveUp() { this.setSelectedIndex(this.selectedIndex - 1); }
  moveDown() { this.setSelectedIndex(this.selectedIndex + 1); }

  setSelectedIndex(index: number) {
    const previous = this.selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(index, this.revisions.length - 1));
    this.paintSelection([previous, this.selectedIndex]);
    const heading = this.rows.find(row => row.heading && row.revisionIndex === this.selectedIndex);
    if (heading) this.scrollChildIntoView(heading.node.id);
    if (previous !== this.selectedIndex) this.emit("selectionChanged");
  }

  // Repaints every row, or only the rows of the given revision indexes when their visual state changed.
  private paintSelection(indexes?: Iterable<number | null | undefined>) {
    if (!indexes) { for (const row of this.rows) this.paintRow(row); return; }
    for (const index of new Set(indexes)) if (index !== null && index !== undefined) for (const row of this.revisionRows[index] ?? []) this.paintRow(row);
  }

  private rowText(row: Row) {
    if (row.text || !row.graph) return row.text ?? { plain: new StyledText([]), drag: new StyledText([]) };
    const graph = row.graph, theme = getTheme(this.ctx);
    const chunks = graphChunks(graph.kind === "edge" ? graph.text : graph.prefix, theme);
    if (graph.kind === "revision") chunks.push(...changeIdChunks(shortChangeId(graph.revision), graph.revision.changePrefix, theme));
    else if (graph.kind === "description") chunks.push(fg(theme.text)(terminalText(graph.revision.description.split("\n")[0] || "(no description)")));
    const plain = new StyledText(chunks);
    const drag = graph.kind === "revision"
      ? new StyledText([...graphChunks(graph.prefix, theme), bg(theme.selected)(bold(fg(theme.selectedText)(shortChangeId(graph.revision))))])
      : plain;
    return row.text = { plain, drag };
  }

  // An expansion above a row pushes it down by the expansion's height, so the upper bound allows for it.
  private nearViewport(row: Row) {
    // Before the first layout the viewport has no height; the terminal's is the most it can be.
    const overscan = 10, height = this.viewport.height || this.ctx.height;
    const expansion = this.expansion?.child.height ?? 0;
    // Layout pulls a scroll position past the end of a shorter snapshot back in, so paint where it will land.
    const top = Math.min(this.scrollTop, Math.max(0, this.rows.length + expansion - height));
    return row.position >= top - expansion - overscan && row.position < top + height + overscan;
  }

  // Runs before layout each frame, so rows scrolled into view by input are painted in the same frame.
  override onLifecyclePass = () => this.paintStale();
  // Scrolling applied during the frame (scroll acceleration) is caught up here.
  protected override onUpdate(deltaTime: number) {
    super.onUpdate(deltaTime);
    this.paintStale();
  }
  private paintStale() {
    for (const row of this.stale) if (this.nearViewport(row)) this.paintRow(row);
  }

  private paintRow(row: Row) {
    if (!this.nearViewport(row)) { this.stale.add(row); return; }
    this.stale.delete(row);
    // An expanded revision yields the highlight to its file list and marks itself open instead.
    const expanded = row.revisionIndex !== null && this.revisions[row.revisionIndex]?.commitId === this.expansion?.commitId;
    const selected = row.revisionIndex === this.selectedIndex && !expanded;
    const draggingSource = this.drag?.kind === "dragging" && this.drag.action === "rebase" &&
      row.revisionIndex !== null && this.revisions[row.revisionIndex]?.commitId === this.drag.revision.commitId;
    const moving = row.revisionIndex !== null && this.movingCommits.has(this.revisions[row.revisionIndex]?.commitId ?? "");
    const source = (row.revisionIndex === this.sourceIndex || draggingSource || moving) && row.heading;
    const drop = this.dropIndex !== null && row.revisionIndex === this.dropIndex;
    const background = drop ? getTheme(this.ctx).drop : selected ? getTheme(this.ctx).graphSelected : getTheme(this.ctx).panel;
    const id = row.revisionIndex === null ? "" : this.revisions[row.revisionIndex]?.commitId ?? "";
    const match = this.searchMatches.has(id);
    const outside = this.outsideFilter.has(id);
    row.label.content = new StyledText([...(row.heading && (match || outside) ? [bold(fg(getTheme(this.ctx).accent)(`${match ? "*" : ""}${outside ? "+" : ""}`))] : []), bold(fg(source ? getTheme(this.ctx).accent : getTheme(this.ctx).text)(drop && row.heading ? "→ " : source ? "● " : expanded && row.heading ? "▾ " : selected && row.heading ? "▶ " : "  ")), ...(draggingSource ? this.rowText(row).drag : this.rowText(row).plain).chunks.map(chunk => match ? bg(getTheme(this.ctx).selected)(chunk) : chunk)]);
    row.node.backgroundColor = background;
    row.label.bg = background;
    const bookmark = row.heading && drop && this.drag?.kind === "dragging" && this.drag.action === "bookmark"
      ? this.drag.bookmark : null;
    if (bookmark && !row.bookmarkPreview) {
      row.bookmarkPreview = new TextRenderable(this.ctx, {
        id: `bookmark-preview-${row.position}`, height: 1, marginLeft: 1, flexShrink: 0,
        selectable: false, wrapMode: "none", opacity: 0.5, fg: getTheme(this.ctx).bookmark,
      });
      row.node.add(row.bookmarkPreview, 1);
    }
    if (row.bookmarkPreview) {
      row.bookmarkPreview.visible = bookmark !== null;
      row.bookmarkPreview.content = bookmark ? terminalText(`[${bookmark.name}${bookmark.conflict ? "!" : ""}]`) : "";
      row.bookmarkPreview.bg = background;
    }
    for (const badge of row.badges) {
      const source = this.bookmarkSources.get(badge)?.bookmark;
      badge.bg = this.drag?.kind === "dragging" && this.drag.action === "bookmark" && source === this.drag.bookmark ? getTheme(this.ctx).drop : background;
      badge.fg = getTheme(this.ctx).bookmark;
    }
  }
}
