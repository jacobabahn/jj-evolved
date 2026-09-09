import { ScrollBoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { terminalText, type Snapshot } from "./repository";

const colors = { background: "#15212c", text: "#d6e2eb", muted: "#91a6b7", selected: "#294a51", accent: "#6ed6bd" };

export class RevisionLog extends ScrollBoxRenderable {
  mouseSelectionEnabled = true;
  private selectedIndex = 0;
  private revisionCount = 0;
  private sourceIndex: number | null = null;
  private rows: { node: TextRenderable; revisionIndex: number | null; heading: boolean; text: string }[] = [];

  constructor(context: RenderContext) {
    super(context, {
      id: "revisions", width: "100%", height: "100%", scrollY: true, scrollX: false,
      backgroundColor: colors.background, contentOptions: { flexDirection: "column" },
    });
  }

  setSnapshot(snapshot: Snapshot) {
    for (const row of this.rows) row.node.destroyRecursively();
    this.rows = [];
    this.revisionCount = snapshot.revisions.length;
    for (const [rowIndex, row] of snapshot.graph.entries()) {
      const revision = row.kind === "edge" ? null : row.revision;
      const revisionIndex = revision ? snapshot.revisions.indexOf(revision) : null;
      const text = row.kind === "edge" ? row.text : row.prefix + (row.kind === "revision"
        ? `${row.revision.changeId.slice(0, 8)}${row.revision.bookmarks ? ` ${row.revision.bookmarks}` : ""}${row.revision.conflict ? " ! conflict" : ""}`
        : row.revision.description.split("\n")[0] || "(no description)");
      const node = new TextRenderable(this.ctx, {
        id: `revision-row-${rowIndex}`, height: 1, width: "100%", flexShrink: 0,
        wrapMode: "none", truncate: true, selectable: false,
        onMouseDown: () => { if (this.mouseSelectionEnabled && revisionIndex !== null) this.setSelectedIndex(revisionIndex); },
      });
      this.add(node);
      this.rows.push({ node, revisionIndex, heading: row.kind === "revision", text: terminalText(text) });
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.revisionCount - 1));
    this.paintSelection();
  }

  getSelectedIndex() { return this.selectedIndex; }
  markSource(index: number | null) { this.sourceIndex = index; this.paintSelection(); }
  moveUp() { this.setSelectedIndex(this.selectedIndex - 1); }
  moveDown() { this.setSelectedIndex(this.selectedIndex + 1); }

  setSelectedIndex(index: number) {
    const previous = this.selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(index, this.revisionCount - 1));
    this.paintSelection();
    const heading = this.rows.find(row => row.heading && row.revisionIndex === this.selectedIndex);
    if (heading) this.scrollChildIntoView(heading.node.id);
    if (previous !== this.selectedIndex) this.emit("selectionChanged");
  }

  private paintSelection() {
    for (const row of this.rows) {
      const selected = row.revisionIndex === this.selectedIndex;
      const source = row.revisionIndex === this.sourceIndex && row.heading;
      row.node.content = `${source ? "● " : selected && row.heading ? "▶ " : "  "}${row.text}`;
      row.node.bg = selected ? colors.selected : colors.background;
      row.node.fg = selected ? "#ffffff" : row.heading ? colors.accent : colors.muted;
    }
  }
}
