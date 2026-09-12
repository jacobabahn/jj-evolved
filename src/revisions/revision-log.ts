import { getTheme } from "../ui/theme";
import { changeIdChunks, graphChunks } from "../ui/jj-highlighting";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, StyledText, bold, fg, bg, type MouseEvent, type RenderContext, type Renderable } from "@opentui/core";
import { terminalText } from "../terminal-text";
import { shortChangeId, type Bookmark, type Revision, type Snapshot } from "../repository/model";


type Row = { node: BoxRenderable; label: TextRenderable; badges: TextRenderable[]; bookmarkPreview: TextRenderable | null; revisionIndex: number | null; heading: boolean; text: StyledText; dragText: StyledText };
type BookmarkSource = { bookmark: Bookmark; revision: Revision };
type DragSource = ({ action: "bookmark" } & BookmarkSource) | { action: "rebase"; revision: Revision };
type Drag = DragSource & { kind: "pressed" | "dragging" };

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
    this.searchMatches = matches;
    this.outsideFilter = outside;
    this.paintSelection();
  }
  private revisions: Revision[] = [];
  private sourceIndex: number | null = null;
  private movingCommits: ReadonlySet<string> = new Set();
  private rows: Row[] = [];
  private bookmarkSources = new Map<Renderable, BookmarkSource>();
  private revisionSources = new Map<Renderable, Revision>();
  private drag: Drag | null = null;
  private dropIndex: number | null = null;

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
    for (const row of this.rows) row.node.destroyRecursively();
    this.rows = [];
    this.bookmarkSources.clear();
    this.revisionSources.clear();
    this.revisions = snapshot.revisions;
    for (const [rowIndex, row] of snapshot.graph.entries()) {
      const revision = row.kind === "edge" ? null : row.revision;
      const revisionIndex = revision ? snapshot.revisions.indexOf(revision) : null;
      const heading = row.kind === "revision";
      const chunks = graphChunks(row.kind === "edge" ? row.text : row.prefix, getTheme(this.ctx));
      if (row.kind === "revision") chunks.push(...changeIdChunks(shortChangeId(row.revision), row.revision.changePrefix, getTheme(this.ctx)));
      else if (row.kind === "description") chunks.push(fg(getTheme(this.ctx).text)(terminalText(row.revision.description.split("\n")[0] || "(no description)")));
      const text = new StyledText(chunks);
      const dragText = row.kind === "revision"
        ? new StyledText([...graphChunks(row.prefix, getTheme(this.ctx)), bg(getTheme(this.ctx).selected)(bold(fg(getTheme(this.ctx).selectedText)(shortChangeId(row.revision))))])
        : text;
      const node = new BoxRenderable(this.ctx, {
        id: `revision-row-${rowIndex}`, height: 1, width: "100%", flexShrink: 0,
        flexDirection: "row", overflow: "hidden",
        onMouseDown: event => {
          if (event.button === 0 && this.mouseSelectionEnabled && revisionIndex !== null &&
            (!event.target || !this.bookmarkSources.has(event.target))) this.setSelectedIndex(revisionIndex);
        },
      });
      const label = new TextRenderable(this.ctx, {
        id: `revision-label-${rowIndex}`, height: 1, flexShrink: heading ? 0 : 1,
        wrapMode: "none", truncate: true, selectable: false, content: text,
      });
      node.add(label);
      if (revision) this.revisionSources.set(label, revision);
      const badges: TextRenderable[] = [];
      let bookmarkPreview: TextRenderable | null = null;
      if (heading && revision) {
        bookmarkPreview = new TextRenderable(this.ctx, {
          id: `bookmark-preview-${rowIndex}`, height: 1, marginLeft: 1, flexShrink: 0,
          selectable: false, wrapMode: "none", visible: false, opacity: 0.5,
          fg: getTheme(this.ctx).bookmark,
        });
        node.add(bookmarkPreview);
        for (const [index, bookmark] of bookmarks.filter(item => item.targets.includes(revision.commitId)).entries()) {
          const badge = new TextRenderable(this.ctx, {
            id: `bookmark-${rowIndex}-${index}`, height: 1, marginLeft: 1, flexShrink: 0, selectable: false, wrapMode: "none",
            content: terminalText(`[${bookmark.name}${bookmark.remote ? `@${bookmark.remote}` : ""}${bookmark.conflict ? "!" : ""}]`),
          });
          node.add(badge);
          badges.push(badge);
          if (!bookmark.remote) this.bookmarkSources.set(badge, { bookmark, revision });
        }
        if (revision.conflict) node.add(new TextRenderable(this.ctx, {
          height: 1, flexShrink: 0, selectable: false, content: " ! conflict", fg: getTheme(this.ctx).conflict,
        }));
      }
      this.add(node);
      this.rows.push({ node, label, badges, bookmarkPreview, revisionIndex, heading, text, dragText });
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.revisions.length - 1));
    this.paintSelection();
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
      this.drag.kind = "dragging";
      this.dropIndex = this.destinationAt(event.x, event.y);
      const destination = this.dropIndex === null ? null : this.revisions[this.dropIndex];
      const operation = this.drag.action === "bookmark" ? `Move ${this.drag.bookmark.name}` : `Rebase ${this.drag.revision.changeId.slice(0, 8)} (only this change)`;
      this.onDragHint(`${operation} → ${destination?.changeId.slice(0, 8) || "choose another change"} · release to preview · Esc cancel`);
      this.paintSelection();
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
    const wasDragging = this.drag.kind === "dragging";
    this.drag = null;
    this.dropIndex = null;
    this.paintSelection();
    if (wasDragging) this.onDragHint("");
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
    this.sourceIndex = index;
    this.movingCommits = movingCommits;
    this.paintSelection();
  }
  moveUp() { this.setSelectedIndex(this.selectedIndex - 1); }
  moveDown() { this.setSelectedIndex(this.selectedIndex + 1); }

  setSelectedIndex(index: number) {
    const previous = this.selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(index, this.revisions.length - 1));
    this.paintSelection();
    const heading = this.rows.find(row => row.heading && row.revisionIndex === this.selectedIndex);
    if (heading) this.scrollChildIntoView(heading.node.id);
    if (previous !== this.selectedIndex) this.emit("selectionChanged");
  }

  private paintSelection() {
    for (const row of this.rows) {
      const selected = row.revisionIndex === this.selectedIndex;
      const draggingSource = this.drag?.kind === "dragging" && this.drag.action === "rebase" &&
        row.revisionIndex !== null && this.revisions[row.revisionIndex]?.commitId === this.drag.revision.commitId;
      const moving = row.revisionIndex !== null && this.movingCommits.has(this.revisions[row.revisionIndex]?.commitId ?? "");
      const source = (row.revisionIndex === this.sourceIndex || draggingSource || moving) && row.heading;
      const drop = this.dropIndex !== null && row.revisionIndex === this.dropIndex;
      const background = drop ? getTheme(this.ctx).drop : selected ? getTheme(this.ctx).graphSelected : getTheme(this.ctx).panel;
      const id = row.revisionIndex === null ? "" : this.revisions[row.revisionIndex]?.commitId ?? "";
      const match = this.searchMatches.has(id);
      const outside = this.outsideFilter.has(id);
      row.label.content = new StyledText([...(row.heading && (match || outside) ? [bold(fg(getTheme(this.ctx).accent)(`${match ? "*" : ""}${outside ? "+" : ""}`))] : []), bold(fg(source ? getTheme(this.ctx).accent : getTheme(this.ctx).text)(drop && row.heading ? "→ " : source ? "● " : selected && row.heading ? "▶ " : "  ")), ...(draggingSource ? row.dragText : row.text).chunks.map(chunk => match ? bg(getTheme(this.ctx).selected)(chunk) : chunk)]);
      row.node.backgroundColor = background;
      row.label.bg = background;
      if (row.bookmarkPreview) {
        const bookmark = drop && this.drag?.kind === "dragging" && this.drag.action === "bookmark"
          ? this.drag.bookmark : null;
        row.bookmarkPreview.visible = bookmark !== null;
        row.bookmarkPreview.content = bookmark ? terminalText(`[${bookmark.name}${bookmark.conflict ? "!" : ""}]`) : "";
        row.bookmarkPreview.bg = background;
      }
      for (const badge of row.badges) {
        const bookmark = this.bookmarkSources.get(badge)?.bookmark;
        badge.bg = this.drag?.kind === "dragging" && this.drag.action === "bookmark" && bookmark === this.drag.bookmark ? getTheme(this.ctx).drop : background;
        badge.fg = getTheme(this.ctx).bookmark;
      }
    }
  }
}
