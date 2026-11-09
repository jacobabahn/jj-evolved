import { SelectRenderable } from "@opentui/core";

/**
 * A select list whose options include group headers. OpenTUI centres the selection in the list, which can leave a
 * header as the last visible row with its first item on the next page; this scrolls by one row to keep them together.
 */
export class GroupedSelect extends SelectRenderable {
  // Not a field initializer: OpenTUI's constructor can lay out the list before subclass fields are set.
  isHeader?: (index: number) => boolean;

  override setSelectedIndex(index: number) {
    super.setSelectedIndex(index);
    this.keepHeaderWithItem();
  }
  override moveUp(steps?: number) {
    super.moveUp(steps);
    this.keepHeaderWithItem();
  }
  override moveDown(steps?: number) {
    super.moveDown(steps);
    this.keepHeaderWithItem();
  }
  protected override onResize(width: number, height: number) {
    super.onResize(width, height);
    this.keepHeaderWithItem();
  }

  private keepHeaderWithItem() {
    // OpenTUI keeps the scroll position private; it is a plain field read on every render.
    const list = this as unknown as { scrollOffset: number; maxVisibleItems: number };
    const last = list.scrollOffset + list.maxVisibleItems - 1;
    if (list.maxVisibleItems < 3 || last >= this.options.length - 1 || !this.isHeader?.(last)) return;
    // The selection is never the header, so it stays in view whether the page moves up a row or, at the top, down one.
    if (list.scrollOffset > 0) list.scrollOffset -= 1;
    else if (this.getSelectedIndex() > 0) list.scrollOffset += 1;
    else return;
    this.requestRender();
  }
}
