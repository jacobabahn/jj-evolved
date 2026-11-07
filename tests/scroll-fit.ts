import { ScrollBoxRenderable, TextBufferRenderable, type Renderable } from "@opentui/core";
import type { UiFixture } from "../tooling/ui";

/**
 * Lists wrapped text in a scroll box that is wider than the viewport, or taller than the lines it wraps to. Either means
 * the text was laid out at a different width than it was measured at: text runs into the border or padding, and a line
 * that exactly fits draws a blank line beneath it.
 */
export function scrollBoxMisfits(ui: UiFixture, id: string) {
  const box = ui.node(id);
  if (!(box instanceof ScrollBoxRenderable)) throw new Error(`${id} is not a scroll box`);
  const right = box.viewport.screenX + box.viewport.width;
  const misfits: string[] = [];
  let checked = 0;
  const walk = (node: Renderable) => {
    if (!node.visible) return;
    if (node instanceof TextBufferRenderable && node.wrapMode !== "none" && node.width > 0 && node.plainText) {
      checked++;
      const label = `${node.id} "${node.plainText.split("\n")[0]!.slice(0, 40)}"`;
      if (node.screenX + node.width > right) misfits.push(`${label} ends at ${node.screenX + node.width}, past the viewport at ${right}`);
      // A row stretches a short text to its tallest neighbour, so extra height is only a blank line when no text
      // beside it wraps to that height.
      const filled = (other: Renderable) => other instanceof TextBufferRenderable && other.visible && other.screenY === node.screenY && other.virtualLineCount === node.height;
      if (node.height > node.virtualLineCount && !node.parent?.getChildren().some(filled)) misfits.push(`${label} is ${node.height} rows for ${node.virtualLineCount} lines`);
      if (node.height < node.virtualLineCount) misfits.push(`${label} is ${node.height} rows for ${node.virtualLineCount} lines`);
    }
    for (const child of node.getChildren()) walk(child);
  };
  walk(box.content);
  if (!checked) throw new Error(`${id} has no wrapped text to check`);
  return misfits;
}
