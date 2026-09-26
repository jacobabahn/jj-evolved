import { getTheme, type Theme } from "../ui/theme";
import { ScrollBoxRenderable, TextRenderable, StyledText, bold, fg, type RenderContext } from "@opentui/core";
import { terminalText } from "../terminal-text";
import type { ChangedFile } from "../repository/model";

const statuses: Record<string, { letter: string; color: keyof Theme }> = {
  added: { letter: "A", color: "added" },
  modified: { letter: "M", color: "bookmark" },
  removed: { letter: "D", color: "conflict" },
  renamed: { letter: "R", color: "commit" },
  copied: { letter: "C", color: "commit" },
};

export class FileList extends ScrollBoxRenderable {
  private files: ChangedFile[] = [];
  private rows: TextRenderable[] = [];
  private empty: TextRenderable;
  private selectedIndex = 0;

  constructor(context: RenderContext, id = "changed-files") {
    super(context, { id, width: "100%", height: "100%", scrollY: true, scrollX: false, backgroundColor: getTheme(context).panel, contentOptions: { flexDirection: "column" } });
    this.empty = new TextRenderable(context, { id: `${id}-empty`, height: 1, width: "100%", flexShrink: 0, selectable: false, wrapMode: "none", truncate: true, content: "Empty change. No changed files.", visible: false });
    this.add(this.empty);
  }

  applyTheme() {
    this.backgroundColor = getTheme(this.ctx).panel;
    this.paint();
  }

  setFiles(files: ChangedFile[]) {
    for (const row of this.rows) row.destroyRecursively();
    this.files = files;
    this.selectedIndex = 0;
    this.rows = files.map((_, index) => {
      const row = new TextRenderable(this.ctx, { id: `${this.id}-row-${index}`, height: 1, width: "100%", flexShrink: 0, selectable: false, wrapMode: "none", truncate: true, onMouseDown: event => { if (event.button === 0) this.setSelectedIndex(index); } });
      this.add(row);
      return row;
    });
    this.empty.visible = !files.length;
    this.paint();
    this.scrollTo(0);
  }

  private paint() {
    const theme = getTheme(this.ctx);
    this.empty.fg = theme.muted;
    for (const [index, file] of this.files.entries()) {
      const row = this.rows[index]!;
      const selected = index === this.selectedIndex;
      const status = statuses[file.status];
      const letter = status?.letter ?? (file.status[0]?.toUpperCase() || "?");
      row.content = new StyledText([bold(fg(theme.text)(selected ? "▶ " : "  ")), bold(fg(theme[status?.color ?? "commit"])(letter)), fg(theme.text)(terminalText(` ${file.path}`))]);
      row.bg = selected ? theme.graphSelected : theme.panel;
    }
  }

  get selectedFile(): ChangedFile | undefined { return this.files[this.selectedIndex]; }
  getSelectedIndex() { return this.selectedIndex; }
  moveUp() { this.setSelectedIndex(this.selectedIndex - 1); }
  moveDown() { this.setSelectedIndex(this.selectedIndex + 1); }
  setSelectedIndex(index: number) {
    const row = this.rows[index];
    if (!row || index === this.selectedIndex) return;
    this.selectedIndex = index;
    this.paint();
    this.scrollChildIntoView(row.id);
    this.emit("selectionChanged");
  }
}
