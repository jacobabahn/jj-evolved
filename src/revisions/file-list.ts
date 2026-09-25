import { getTheme } from "../ui/theme";
import { ScrollBoxRenderable, TextRenderable, StyledText, bold, fg, type RenderContext } from "@opentui/core";
import { terminalText } from "../terminal-text";
import type { ChangedFile } from "../repository/model";

const statusLetters: Record<string, string> = { added: "A", modified: "M", removed: "D", renamed: "R", copied: "C" };

export class FileList extends ScrollBoxRenderable {
  private files: ChangedFile[] = [];
  private rows: TextRenderable[] = [];
  private selectedIndex = 0;

  constructor(context: RenderContext, id = "changed-files") {
    super(context, { id, width: "100%", height: "100%", scrollY: true, scrollX: false, backgroundColor: getTheme(context).panel, contentOptions: { flexDirection: "column" } });
  }

  applyTheme() {
    this.backgroundColor = getTheme(this.ctx).panel;
    this.setFiles(this.files, this.selectedIndex);
  }

  setFiles(files: ChangedFile[], selectedIndex = 0) {
    for (const row of this.rows) row.destroyRecursively();
    this.rows = [];
    this.files = files;
    this.selectedIndex = Math.max(0, Math.min(selectedIndex, files.length - 1));
    if (!files.length) {
      const empty = new TextRenderable(this.ctx, { id: `${this.id}-empty`, height: 1, width: "100%", flexShrink: 0, selectable: false, wrapMode: "none", truncate: true, fg: getTheme(this.ctx).muted, content: "Empty change. No changed files." });
      this.add(empty);
      this.rows.push(empty);
      return;
    }
    for (const [index] of files.entries()) {
      const row = new TextRenderable(this.ctx, { id: `${this.id}-row-${index}`, height: 1, width: "100%", flexShrink: 0, selectable: false, wrapMode: "none", truncate: true, onMouseDown: event => { if (event.button === 0) this.setSelectedIndex(index); } });
      this.add(row);
      this.rows.push(row);
    }
    this.paintSelection();
  }

  private statusColor(status: string) {
    const theme = getTheme(this.ctx);
    return status === "added" ? theme.added : status === "removed" ? theme.conflict : status === "modified" ? theme.bookmark : theme.commit;
  }

  private paintSelection() {
    const theme = getTheme(this.ctx);
    for (const [index, row] of this.rows.entries()) {
      const file = this.files[index];
      if (!file) continue;
      const selected = index === this.selectedIndex;
      const letter = statusLetters[file.status] ?? (file.status[0]?.toUpperCase() || "?");
      row.content = new StyledText([bold(fg(theme.text)(selected ? "▶ " : "  ")), bold(fg(this.statusColor(file.status))(letter)), fg(theme.text)(terminalText(` ${file.path}`))]);
      row.bg = selected ? theme.graphSelected : theme.panel;
    }
  }

  get selectedFile(): ChangedFile | undefined { return this.files[this.selectedIndex]; }
  getSelectedIndex() { return this.selectedIndex; }
  moveUp() { this.setSelectedIndex(this.selectedIndex - 1); }
  moveDown() { this.setSelectedIndex(this.selectedIndex + 1); }
  setSelectedIndex(index: number) {
    const previous = this.selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(index, this.files.length - 1));
    this.paintSelection();
    const row = this.rows[this.selectedIndex];
    if (row && this.files.length) this.scrollChildIntoView(row.id);
    if (previous !== this.selectedIndex) this.emit("selectionChanged");
  }
}
