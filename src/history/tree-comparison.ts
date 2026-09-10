import { getTheme } from "../ui/theme";
import { highlightJjText } from "../ui/jj-highlighting";
import { BorderChars, BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import type { TreeComparison } from "../repository/model";

export class TreeComparisonView extends BoxRenderable {
  private readonly afterColumn: BoxRenderable;
  private readonly before: TextRenderable;
  private readonly after: TextRenderable;

  constructor(ctx: RenderContext, id: string) {
    super(ctx, { id, width: "100%", flexDirection: "row", flexShrink: 0, visible: false });
    const column = (side: "before" | "after", title: string) => {
      const column = new BoxRenderable(ctx, { id: `${id}-${side}-column`, title, border: side === "after" ? true : ["top", "right", "bottom"],
        customBorderChars: side === "after" ? { ...BorderChars.single, topRight: "┬", bottomRight: "┴" } : BorderChars.single,
        borderColor: getTheme(this.ctx).accent, width: "50%", height: "100%", minWidth: 0 });
      const text = new TextRenderable(ctx, { id: `${id}-${side}`, width: "100%",
        fg: getTheme(this.ctx).text, wrapMode: "none", truncate: true, flexShrink: 0 });
      const viewport = new BoxRenderable(ctx, { width: "100%", height: "100%", overflow: "hidden" });
      viewport.add(text);
      column.add(viewport);
      this.add(column);
      return { column, text };
    };
    const after = column("after", " Proposed tree ");
    this.after = after.text;
    this.afterColumn = after.column;
    this.before = column("before", " Current tree ").text;
  }

  applyTheme() {
    for (const child of this.getChildren()) {
      if (child instanceof BoxRenderable) child.borderColor = getTheme(this.ctx).accent;
    }
    this.before.fg = this.after.fg = getTheme(this.ctx).text;
  }

  setTrees(trees: TreeComparison | null, action?: "rebase" | "squash") {
    this.applyTheme();
    this.visible = trees !== null;
    this.afterColumn.title = action ? ` After ${action} ` : " Proposed tree ";
    this.before.content = highlightJjText(trees?.before.trimEnd() || "", trees?.beforePrefixes, getTheme(this.ctx));
    this.after.content = highlightJjText(trees?.after.trimEnd() || "", trees?.afterPrefixes, getTheme(this.ctx));
    this.height = trees ? Math.max(trees.before.trimEnd().split("\n").length, trees.after.trimEnd().split("\n").length) + 2 : 0;
  }
}
