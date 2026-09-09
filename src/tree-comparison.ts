import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import type { TreeComparison } from "./repository";

export class TreeComparisonView extends BoxRenderable {
  private readonly before: TextRenderable;
  private readonly after: TextRenderable;

  constructor(ctx: RenderContext, id: string) {
    super(ctx, { id, width: "100%", flexDirection: "row", flexShrink: 0, visible: false });
    const column = (title: string) => {
      const column = new BoxRenderable(ctx, { id: `${id}-${title.toLowerCase()}-column`, title, border: true,
        borderColor: "#6ed6bd", width: "50%", height: "100%", minWidth: 0 });
      const text = new TextRenderable(ctx, { id: `${id}-${title.toLowerCase()}`, width: "100%",
        fg: "#d6e2eb", wrapMode: "none", truncate: true, flexShrink: 0 });
      column.add(text);
      this.add(column);
      return text;
    };
    this.before = column("Before");
    this.after = column("After");
  }

  setTrees(trees: TreeComparison | null) {
    this.visible = trees !== null;
    this.before.content = trees?.before.trimEnd() || "";
    this.after.content = trees?.after.trimEnd() || "";
    this.height = trees ? Math.max(trees.before.trimEnd().split("\n").length, trees.after.trimEnd().split("\n").length) + 2 : 0;
  }
}
