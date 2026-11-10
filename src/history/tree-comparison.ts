import { getTheme } from "../ui/theme";
import { highlightJjText } from "../ui/jj-highlighting";
import { BorderChars, BoxRenderable, TextRenderable, bold, fg, StyledText, type RenderContext } from "@opentui/core";
import type { TreeComparison } from "../repository/model";
import { EllipsisText } from "../ui/ellipsis-text";

export class TreeComparisonView extends BoxRenderable {
  /** One line above the trees when the result has conflicts its source does not. */
  private readonly headline: EllipsisText;
  private readonly columns: BoxRenderable;
  private conflicts = 0;
  private readonly afterColumn: BoxRenderable;
  private readonly before: TextRenderable;
  private readonly after: TextRenderable;

  constructor(ctx: RenderContext, id: string) {
    super(ctx, { id, width: "100%", flexDirection: "column", flexShrink: 0, visible: false });
    this.headline = new EllipsisText(ctx, { id: `${id}-headline`, width: "100%", height: 1, flexShrink: 0, visible: false });
    this.columns = new BoxRenderable(ctx, { id: `${id}-columns`, width: "100%", flexGrow: 1, flexDirection: "row" });
    this.add(this.headline);
    this.add(this.columns);
    const column = (side: "before" | "after", title: string, first: boolean) => {
      const column = new BoxRenderable(ctx, { id: `${id}-${side}-column`, title, border: first ? true : ["top", "right", "bottom"],
        customBorderChars: first ? { ...BorderChars.single, topRight: "┬", bottomRight: "┴" } : BorderChars.single,
        borderColor: getTheme(this.ctx).accent, width: "50%", height: "100%", minWidth: 0 });
      const text = new EllipsisText(ctx, { id: `${id}-${side}`, width: "100%",
        fg: getTheme(this.ctx).text, flexShrink: 0 });
      const viewport = new BoxRenderable(ctx, { width: "100%", height: "100%", overflow: "hidden" });
      viewport.add(text);
      column.add(viewport);
      this.columns.add(column);
      return { column, text };
    };
    this.before = column("before", " Current tree ", true).text;
    const after = column("after", " Proposed tree ", false);
    this.after = after.text;
    this.afterColumn = after.column;
  }

  applyTheme() {
    for (const child of this.columns.getChildren()) {
      if (child instanceof BoxRenderable) child.borderColor = getTheme(this.ctx).accent;
    }
    this.before.fg = this.after.fg = getTheme(this.ctx).text;
    const count = this.conflicts;
    this.headline.content = new StyledText([bold(fg(getTheme(this.ctx).conflict)(`! Creates ${count} conflict${count === 1 ? "" : "s"}`))]);
  }

  setTrees(trees: TreeComparison | null, action?: "rebase" | "squash") {
    this.conflicts = trees?.newConflicts ?? 0;
    this.headline.visible = this.conflicts > 0;
    this.applyTheme();
    this.visible = trees !== null;
    this.afterColumn.title = action ? ` After ${action} ` : " Proposed tree ";
    this.before.content = highlightJjText(trees?.before.trimEnd() || "", trees?.beforePrefixes, getTheme(this.ctx));
    this.after.content = highlightJjText(trees?.after.trimEnd() || "", trees?.afterPrefixes, getTheme(this.ctx));
    this.height = trees ? Math.max(trees.before.trimEnd().split("\n").length, trees.after.trimEnd().split("\n").length) + 2 + (this.conflicts ? 1 : 0) : 0;
  }
}
