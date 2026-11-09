import { TextRenderable, type OptimizedBuffer, type RenderContext, type Renderable, type TextOptions } from "@opentui/core";

export const ELLIPSIS = "…";

type Clipping = { getScissorRect(): { x: number; width: number } };

/**
 * Text that does not fit is cut at the end, and its last visible column becomes "…". This is the one rule for cutting
 * text. opentui's own `truncate` cuts in the middle with "...", and clipped text just stops at the edge.
 *
 * The text keeps its full content, so layout measures it at full width and it grows back when there is room again.
 * Each line is cut on its own and never wraps. The cut falls where the text stops being visible: its own right edge,
 * or the edge of an ancestor that clips it, such as a row that a bookmark badge runs past.
 */
export class EllipsisText extends TextRenderable {
  constructor(ctx: RenderContext, options: TextOptions) {
    super(ctx, { ...options, wrapMode: "none", truncate: false });
  }

  /** The screen column just past the last one that shows this text. */
  private visibleRight() {
    let right = this.screenX + this.width;
    for (let ancestor: Renderable | null = this.parent; ancestor; ancestor = ancestor.parent) {
      // The clip rectangle ignores borders and padding, so it is the area children actually show in.
      if (ancestor.overflow === "visible") continue;
      const clip = (ancestor as unknown as Clipping).getScissorRect();
      right = Math.min(right, clip.x + clip.width);
    }
    return right;
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    super.renderSelf(buffer);
    const right = this.visibleRight();
    if (right <= 0) return;
    const widths = this.lineInfo.lineWidthCols;
    for (let row = 0; row < Math.min(this.height, widths.length - this.scrollY); row++) {
      if (this.screenX + (widths[row + this.scrollY] ?? 0) - this.scrollX > right) buffer.drawText(ELLIPSIS, right - 1, this.screenY + row, this.fg);
    }
  }
}

/** Cuts a string to `width` terminal columns by the same rule, for widgets that draw their strings themselves. */
export function fitText(text: string, width: number): string {
  if (Bun.stringWidth(text) <= width) return text;
  if (width <= 0) return "";
  let kept = "";
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (Bun.stringWidth(kept + segment) > width - 1) break;
    kept += segment;
  }
  return kept + ELLIPSIS;
}
