import { changeIdChunks, graphChunks, jjColors } from "./jj-highlighting";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, StyledText, bold, fg, type MouseEvent, type RenderContext, type Renderable } from "@opentui/core";
import { terminalText, shortChangeId, type Bookmark, type Revision, type Snapshot } from "./repository";

const colors = { background: "#15212c", text: "#d6e2eb", muted: "#91a6b7", selected: "#294a51", accent: "#6ed6bd", drop: "#435d38" };

type Row = { node: BoxRenderable; label: TextRenderable; badges: TextRenderable[]; revisionIndex: number | null; heading: boolean; text: StyledText };
type BookmarkSource = { bookmark: Bookmark; revision: Revision };
type Drag = BookmarkSource & { kind: "pressed" | "dragging" };

export class RevisionLog extends ScrollBoxRenderable {
  mouseSelectionEnabled = true;
  canDragBookmark = () => false;
  onBookmarkDrop = (_name: string, _revision: Revision) => {};
  onDragHint = (_text: string) => {};
  private selectedIndex = 0;
  private revisions: Revision[] = [];
  private sourceIndex: number | null = null;
  private rows: Row[] = [];
  private bookmarkSources = new Map<Renderable, BookmarkSource>();
  private drag: Drag | null = null;
  private dropIndex: number | null = null;

  constructor(context: RenderContext) {
    super(context, {
      id: "revisions", width: "100%", height: "100%", scrollY: true, scrollX: false,
      backgroundColor: colors.background, contentOptions: { flexDirection: "column" },
    });
  }

  setSnapshot(snapshot: Snapshot, bookmarks: Bookmark[]) {
    this.cancelDrag();
    for (const row of this.rows) row.node.destroyRecursively();
    this.rows = [];
    this.bookmarkSources.clear();
    this.revisions = snapshot.revisions;
    for (const [rowIndex, row] of snapshot.graph.entries()) {
      const revision = row.kind === "edge" ? null : row.revision;
      const revisionIndex = revision ? snapshot.revisions.indexOf(revision) : null;
      const heading = row.kind === "revision";
      const chunks = graphChunks(row.kind === "edge" ? row.text : row.prefix);
      if (row.kind === "revision") chunks.push(...changeIdChunks(shortChangeId(row.revision), row.revision.changePrefix));
      else if (row.kind === "description") chunks.push(fg(jjColors.text)(terminalText(row.revision.description.split("\n")[0] || "(no description)")));
      const text = new StyledText(chunks);
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
      const badges: TextRenderable[] = [];
      if (heading && revision) {
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
          height: 1, flexShrink: 0, selectable: false, content: " ! conflict", fg: "#ffad9e",
        }));
      }
      this.add(node);
      this.rows.push({ node, label, badges, revisionIndex, heading, text });
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.revisions.length - 1));
    this.paintSelection();
  }

  handleBookmarkMouse(event: MouseEvent) {
    if (event.type === "down") {
      this.cancelDrag();
      const source = event.target ? this.bookmarkSources.get(event.target) : undefined;
      if (event.button === 0 && source && this.canDragBookmark()) {
        this.drag = { kind: "pressed", ...source };
        event.preventDefault();
      }
      return;
    }
    if (!this.drag) return;
    if (!this.canDragBookmark()) { this.cancelDrag(); return; }
    if (event.type === "drag" && event.button === 0) {
      this.drag.kind = "dragging";
      this.dropIndex = this.destinationAt(event.x, event.y);
      const destination = this.dropIndex === null ? null : this.revisions[this.dropIndex];
      this.onDragHint(`Move ${this.drag.bookmark.name} → ${destination?.changeId.slice(0, 8) || "choose another change"} · release to preview · Esc cancel`);
      this.paintSelection();
    } else if (event.type === "up" && event.button === 0) {
      const drag = this.drag;
      const index = this.destinationAt(event.x, event.y);
      const destination = index === null ? null : this.revisions[index];
      this.cancelDrag();
      if (drag.kind === "dragging" && destination) this.onBookmarkDrop(drag.bookmark.name, destination);
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
  markSource(index: number | null) { this.sourceIndex = index; this.paintSelection(); }
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
      const source = row.revisionIndex === this.sourceIndex && row.heading;
      const drop = this.dropIndex !== null && row.revisionIndex === this.dropIndex;
      const background = drop ? colors.drop : selected ? colors.selected : colors.background;
      row.label.content = new StyledText([bold(fg(source ? colors.accent : "#ffffff")(drop && row.heading ? "→ " : source ? "● " : selected && row.heading ? "▶ " : "  ")), ...row.text.chunks]);
      row.node.backgroundColor = background;
      row.label.bg = background;
      for (const badge of row.badges) {
        const bookmark = this.bookmarkSources.get(badge)?.bookmark;
        badge.bg = this.drag?.kind === "dragging" && bookmark === this.drag.bookmark ? colors.drop : background;
        badge.fg = jjColors.bookmark;
      }
    }
  }
}
