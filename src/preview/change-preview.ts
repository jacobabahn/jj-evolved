import { getTheme } from "../ui/theme";
import { highlightJjText } from "../ui/jj-highlighting";
import { BoxRenderable, CodeRenderable, DiffRenderable, ScrollBoxRenderable, StyledText, SyntaxStyle, TextRenderable, pathToFiletype, type ColorInput, type RenderContext, type Renderable } from "@opentui/core";
import { terminalText } from "../terminal-text";

// Each block becomes one child renderable while it is near the viewport; update returns false when the existing child cannot
// show the block. shape is what decides the block's height at a given width, and estimate guesses that height before the
// block has been laid out.
type Block = { id: string; shape: string; estimate: (width: number) => number; create: () => Renderable; update: (existing: Renderable) => boolean };
type Height = { width: number; value: number; measured: boolean };
const signatures = new WeakMap<Renderable, string>();
// Applying tree-sitter highlights stalls the main thread for about 1.65 ms per KB of highlighted text, plus a few ms per hunk,
// however the text is split into hunks: a 12 MB diff across 400 files froze the app for about 19 seconds. The budget caps that
// stall near 300 ms. Past it a hunk keeps its diff colours but not syntax colours.
export const highlightLimits = { totalChars: 128_000 };
// opentui bundles tree-sitter parsers only for these filetypes (defaultParserDescriptors in @opentui/core, with the react
// variants as aliases) and exports no way to ask. pathToFiletype names many more, but those are never highlighted, so they
// get no filetype: they would spend the budget on colours that never come, and each would cost a worker round trip.
export const parserFiletypes: ReadonlySet<string> = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact", "markdown", "markdown_inline", "zig"]);
const styledSignature = (text: StyledText) => JSON.stringify(text.chunks.map(chunk => [chunk.text, chunk.fg?.toInts(), chunk.bg?.toInts(), chunk.attributes]));

// A line of text takes this many rows at a given width, if it wraps at characters; word wrapping can take a few more.
const rows = (text: string, width: number) => {
  let total = 0;
  for (let start = 0; start <= text.length;) {
    const end = text.indexOf("\n", start);
    const length = (end < 0 ? text.length : end) - start;
    total += Math.max(1, Math.ceil(length / Math.max(1, width)));
    if (end < 0) break;
    start = end + 1;
  }
  return total;
};
// Blocks at most this many terminal heights above and below the viewport have renderables. Scrolling a page in either
// direction then shows blocks that already exist, and a diff of any length keeps a few screens of renderables alive.
const margin = 1;
// Columns a unified diff spends on line numbers and signs, besides the digits of its last line number.
const GUTTER = 3;
// opentui gives a diff's code 100% of the row beside its gutter. Yoga then measures the code's height at the width left
// beside the gutter but lays it out a column wider, where its text wraps to fewer rows, leaving blank rows under the hunk.
// The full preview used to hide this because the overflow also squeezed the scroll bar out of the layout. Giving the code
// exactly the width beside the gutter keeps measuring and drawing in step. Returns whether the width changed.
const pointUnit = 1; // Yoga's unit for a width in cells, as opposed to a percentage or auto.
const fitCode = (diff: Renderable) => {
  const side = diff.findDescendantById(`${diff.id}-left`);
  const gutter = diff.findDescendantById(`${diff.id}-left-gutter`);
  const code = diff.findDescendantById(`${diff.id}-left-code`);
  if (!side || !gutter || !code) return false;
  const width = side.getLayoutNode().getComputedWidth() - gutter.getLayoutNode().getComputedWidth();
  const style = code.getLayoutNode().getWidth();
  if (!(width > 0) || (style.unit === pointUnit && style.value === width)) return false;
  code.width = width;
  return true;
};

export class ChangePreview extends BoxRenderable {
  prefixes: ReadonlyMap<string, string> = new Map();
  private value = "";
  private syntax = this.createSyntax();
  private items: Block[] = [];
  private positions = new Map<string, number>();
  private heights = new WeakMap<Block, Height>();
  // The block each live child shows, so a frame only updates children whose block changed.
  private shown = new WeakMap<Renderable, Block>();
  // Stand in for the blocks before and after the window. Padding cannot: opentui's diffs measure their height within what the
  // parent has left, and padding taller than the viewport leaves them none.
  private above: BoxRenderable;
  private below: BoxRenderable;
  private spaced = [0, 0];

  private createSyntax() { return SyntaxStyle.fromStyles({
    default: { fg: getTheme(this.ctx).text }, keyword: { fg: getTheme(this.ctx).changeId, bold: true },
    string: { fg: getTheme(this.ctx).bookmark }, comment: { fg: getTheme(this.ctx).muted, italic: true },
    number: { fg: getTheme(this.ctx).number }, boolean: { fg: getTheme(this.ctx).number }, constant: { fg: getTheme(this.ctx).number },
    function: { fg: getTheme(this.ctx).commit }, type: { fg: getTheme(this.ctx).accent }, property: { fg: getTheme(this.ctx).property },
    operator: { fg: getTheme(this.ctx).operator }, punctuation: { fg: getTheme(this.ctx).operator },
  }); }

  applyTheme() {
    for (const child of this.getChildren()) if (this.shown.has(child)) child.destroyRecursively();
    this.syntax.destroy();
    this.syntax = this.createSyntax();
    this.content = this.value;
  }

  constructor(ctx: RenderContext, id: string, content = "") {
    super(ctx, { id, width: "100%", flexDirection: "column", flexShrink: 0 });
    this.above = new BoxRenderable(ctx, { id: `${id}-above`, height: 0, flexShrink: 0 });
    this.below = new BoxRenderable(ctx, { id: `${id}-below`, height: 0, flexShrink: 0 });
    this.add(this.above);
    this.add(this.below);
    this.content = content;
  }

  get content() { return this.value; }
  // Refreshes usually repeat the text on screen, so unchanged sections keep their renderables and changed hunks
  // update in place; only cells whose content differs are redrawn.
  set content(value: string) {
    this.value = terminalText(value);
    const previous = new Map(this.items.map(block => [block.id, block]));
    this.items = this.blocks();
    this.positions = new Map(this.items.map((block, index) => [block.id, index]));
    // A block whose text has the same shape keeps the height it was measured at, so a reload lays out like the text it replaces.
    for (const block of this.items) {
      const old = previous.get(block.id);
      const height = old && this.heights.get(old);
      if (old && height?.measured && old.shape === block.shape) this.heights.set(block, height);
    }
    this.layoutWindow();
  }

  // Only blocks near the viewport have renderables; two spacers stand in for the rest. It runs before every layout, so
  // scrolling, resizing and new text all move the window.
  override onLifecyclePass = () => { this.layoutWindow(); };

  private layoutWindow() {
    const laidOut = this.getLayoutNode().getComputedWidth();
    const width = laidOut > 0 ? Math.round(laidOut) : this.ctx.width;
    let changed = false;
    for (const child of this.getChildren()) {
      const block = this.shown.get(child);
      const value = child.getLayoutNode().getComputedHeight();
      if (!block || !(laidOut > 0) || !Number.isFinite(value)) continue;
      if (child instanceof DiffRenderable && fitCode(child)) changed = true;
      const height = this.heights.get(block);
      if (height?.width !== width || height.value !== value || !height.measured) changed = true;
      this.heights.set(block, { width, value, measured: true });
    }
    const height = (block: Block) => {
      let known = this.heights.get(block);
      if (known?.width !== width) this.heights.set(block, known = { width, value: block.estimate(width), measured: false });
      return known.value;
    };
    const scroll = this.scrollBox();
    // No viewport is taller than the terminal. The viewport's own height comes from the last layout, which may predate the
    // preview being shown, and would leave the window empty until something else drew a frame.
    const view = this.ctx.height;
    // The previous layout places this preview inside the scrolled content; any siblings above it scroll too.
    const offset = scroll ? this.y - scroll.content.y : 0;
    let start = 0, end = 0;
    // Creating a block above the viewport replaces its estimated height with a measured one, so the window is worked out again.
    for (let pass = 0; pass < 4; pass++) {
      const top = (scroll ? scroll.scrollTop : 0) - offset;
      let y = 0;
      start = this.items.length; end = this.items.length;
      for (const [index, block] of this.items.entries()) {
        const bottom = y + height(block);
        if (start === this.items.length && bottom > top - margin * view) start = index;
        if (y >= top + (1 + margin) * view) { end = index; break; }
        y = bottom;
      }
      let shift = 0, at = 0;
      for (let index = 0; index < start; index++) at += height(this.items[index]!);
      for (const child of this.getChildren()) {
        const position = this.positions.get(child.id);
        if (this.shown.has(child) && (position === undefined || position < start || position >= end)) child.destroyRecursively();
      }
      for (let index = start; index < end; index++) {
        const block = this.items[index]!;
        const assumed = height(block);
        let existing = this.getRenderable(block.id);
        if (existing && this.shown.get(existing) !== block) {
          if (block.update(existing)) this.shown.set(existing, block);
          else { existing.destroyRecursively(); existing = undefined; }
        }
        if (!existing) {
          const created = block.create();
          this.shown.set(created, block);
          if (laidOut > 0) {
            // Laying out the new child on its own gives its height now, before the frame that draws it.
            created.getLayoutNode().calculateLayout(width, undefined);
            if (created instanceof DiffRenderable && fitCode(created)) created.getLayoutNode().calculateLayout(width, undefined);
            const value = created.getLayoutNode().getComputedHeight();
            this.heights.set(block, { width, value, measured: true });
            if (at < top) shift += value - assumed;
          } else changed = true;
          this.add(created, index - start + 1);
        }
        at += assumed;
      }
      if (!shift || !scroll) break;
      // Content above the viewport grew or shrank; scrolling by as much keeps what is on screen in place.
      scroll.scrollTop += shift;
    }
    let before = 0, after = 0;
    for (const [index, block] of this.items.entries()) {
      if (index < start) before += height(block);
      else if (index >= end) after += height(block);
    }
    // The height getter reports at least 1, so the spacers' set heights are kept here.
    if (this.spaced[0] !== before) this.above.height = this.spaced[0] = before;
    if (this.spaced[1] !== after) this.below.height = this.spaced[1] = after;
    // A child laid out at a new height can move the window, so the next frame checks again until heights settle.
    if (changed) this.requestRender();
  }

  private scrollBox() {
    for (let parent = this.parent; parent; parent = parent.parent) if (parent instanceof ScrollBoxRenderable) return parent;
    return undefined;
  }

  private blocks(): Block[] {
    const theme = getTheme(this.ctx);
    const blocks: Block[] = [];
    const text = (id: string, content: string | StyledText, fg: ColorInput, options: { width?: "100%"; wrapMode?: "word" } = { width: "100%", wrapMode: "word" }) => {
      // A theme change rebuilds every child, so the text alone decides whether a child needs repainting.
      const signature = typeof content === "string" ? content : styledSignature(content);
      const plain = typeof content === "string" ? content : content.chunks.map(chunk => chunk.text).join("");
      blocks.push({
        id, shape: signature,
        estimate: width => options.wrapMode ? rows(plain, width) : plain.split("\n").length,
        create: () => { const renderable = new TextRenderable(this.ctx, { id, content, fg, flexShrink: 0, ...options }); signatures.set(renderable, signature); return renderable; },
        update: existing => {
          if (!(existing instanceof TextRenderable)) return false;
          if (signatures.get(existing) !== signature) { existing.content = content; signatures.set(existing, signature); }
          return true;
        },
      });
    };
    let highlightedChars = 0;
    const sections = this.value.split(/(?=^diff --git )/m);
    for (const [index, section] of sections.entries()) {
      const id = `${this.id}-${index}`;
      const path = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ?? /^--- a\/(.+)$/m.exec(section)?.[1];
      if (!section.startsWith("diff --git ") || !/^@@ /m.test(section)) {
        text(id, highlightJjText(section.replace(/\n$/, ""), this.prefixes, theme), theme.text);
        continue;
      }
      const headerEnd = section.search(/^@@ /m);
      const header = section.slice(0, headerEnd);
      text(`${id}-header`, header.trimEnd(), theme.muted);
      for (const [hunkIndex, hunk] of section.slice(headerEnd).split(/(?=^@@ )/m).entries()) {
        const lines = hunk.split("\n");
        const end = lines.findIndex((line, index) => index > 0 && !/^(?:[ +\-]|\\ No newline at end of file)/.test(line));
        const patch = end < 0 ? hunk : lines.slice(0, end).join("\n") + "\n";
        const trailing = end < 0 ? "" : lines.slice(end).join("\n").trim();
        // Hunks are budgeted in document order, so what the user reads first keeps its colours. A hunk that does not fit what is
        // left is skipped, and smaller hunks after it can still be highlighted.
        const detected = pathToFiletype(path ?? "");
        const grammar = detected && parserFiletypes.has(detected) ? detected : undefined;
        const skipped = !!grammar && highlightedChars + patch.length > highlightLimits.totalChars;
        const filetype = skipped ? undefined : grammar;
        if (filetype) highlightedChars += patch.length;
        text(`${id}-hunk-${hunkIndex}`, skipped ? `${lines[0] ?? ""}  (diff too large to highlight)` : lines[0] ?? "", theme.hunk);
        const diffId = `${id}-diff-${hunkIndex}`;
        const diff = header + patch;
        const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(lines[0] ?? "");
        const lastLine = range ? Math.max(Number(range[1]) + Number(range[2] ?? 1), Number(range[3]) + Number(range[4] ?? 1)) : 0;
        const gutter = String(lastLine).length + GUTTER;
        blocks.push({
          id: diffId, shape: diff,
          // The diff shows the patch's lines after its @@ line, without "\\ No newline" markers; the patch ends in a newline.
          estimate: width => rows(patch.slice(patch.indexOf("\n") + 1, -1), width - gutter) - (patch.match(/^\\/gm)?.length ?? 0),
          create: () => {
            const renderable = new DiffRenderable(this.ctx, {
              id: diffId, width: "100%", diff, filetype, syntaxStyle: this.syntax,
              lineNumberFg: theme.muted, lineNumberBg: theme.bg,
              addedLineNumberBg: theme.addedGutter, removedLineNumberBg: theme.removedGutter,
              view: "unified", showLineNumbers: true, wrapMode: "word", flexShrink: 0,
              fg: theme.text, addedBg: theme.addedBg, removedBg: theme.removedBg, contextBg: theme.bg,
              addedContentBg: theme.addedBg, removedContentBg: theme.removedBg, contextContentBg: theme.bg,
              addedSignColor: theme.addedSign, removedSignColor: theme.removedSign,
            });
            // Streaming code keeps its highlighted text on screen while a changed hunk is highlighted again.
            const code = renderable.findDescendantById(`${diffId}-left-code`);
            if (code instanceof CodeRenderable) code.streaming = true;
            return renderable;
          },
          update: existing => {
            if (!(existing instanceof DiffRenderable) || existing.filetype !== filetype) return false;
            if (existing.diff === diff) return true;
            const code = existing.findDescendantById(`${diffId}-left-code`);
            // The first highlight has already drawn, so later text waits for its highlight instead of flashing unstyled.
            if (code instanceof CodeRenderable) code.drawUnstyledText = false;
            existing.diff = diff;
            return true;
          },
        });
        if (patch.includes("\\ No newline at end of file")) text(`${id}-newline-${hunkIndex}`, "\\ No newline at end of file", theme.muted, {});
        if (trailing) text(`${id}-after-${hunkIndex}`, highlightJjText(trailing, this.prefixes, theme), theme.text);
      }
    }
    return blocks;
  }

  override destroy() {
    super.destroy();
    this.syntax.destroy();
  }
}
