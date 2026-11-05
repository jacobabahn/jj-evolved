import { getTheme } from "../ui/theme";
import { highlightJjText } from "../ui/jj-highlighting";
import { BoxRenderable, CodeRenderable, DiffRenderable, StyledText, SyntaxStyle, TextRenderable, pathToFiletype, type ColorInput, type RenderContext, type Renderable } from "@opentui/core";
import { terminalText } from "../terminal-text";

// Each block is one child renderable; update returns false when the existing child cannot show the block.
type Block = { id: string; create: () => Renderable; update: (existing: Renderable) => boolean };
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

export class ChangePreview extends BoxRenderable {
  prefixes: ReadonlyMap<string, string> = new Map();
  private value = "";
  private syntax = this.createSyntax();

  private createSyntax() { return SyntaxStyle.fromStyles({
    default: { fg: getTheme(this.ctx).text }, keyword: { fg: getTheme(this.ctx).changeId, bold: true },
    string: { fg: getTheme(this.ctx).bookmark }, comment: { fg: getTheme(this.ctx).muted, italic: true },
    number: { fg: getTheme(this.ctx).number }, boolean: { fg: getTheme(this.ctx).number }, constant: { fg: getTheme(this.ctx).number },
    function: { fg: getTheme(this.ctx).commit }, type: { fg: getTheme(this.ctx).accent }, property: { fg: getTheme(this.ctx).property },
    operator: { fg: getTheme(this.ctx).operator }, punctuation: { fg: getTheme(this.ctx).operator },
  }); }

  applyTheme() {
    for (const child of this.getChildren()) child.destroyRecursively();
    this.syntax.destroy();
    this.syntax = this.createSyntax();
    this.content = this.value;
  }

  constructor(ctx: RenderContext, id: string, content = "") {
    super(ctx, { id, width: "100%", flexDirection: "column", flexShrink: 0 });
    this.content = content;
  }

  get content() { return this.value; }
  // Refreshes usually repeat the text on screen, so unchanged sections keep their renderables and changed hunks
  // update in place; only cells whose content differs are redrawn.
  set content(value: string) {
    this.value = terminalText(value);
    const blocks = this.blocks();
    const wanted = new Set(blocks.map(block => block.id));
    for (const child of this.getChildren()) if (!wanted.has(child.id)) child.destroyRecursively();
    for (const [index, block] of blocks.entries()) {
      const existing = this.getRenderable(block.id);
      if (existing && block.update(existing)) continue;
      existing?.destroyRecursively();
      this.add(block.create(), index);
    }
  }

  private blocks(): Block[] {
    const theme = getTheme(this.ctx);
    const blocks: Block[] = [];
    const text = (id: string, content: string | StyledText, fg: ColorInput, options: { width?: "100%"; wrapMode?: "word" } = { width: "100%", wrapMode: "word" }) => {
      // A theme change rebuilds every child, so the text alone decides whether a child needs repainting.
      const signature = typeof content === "string" ? content : styledSignature(content);
      blocks.push({
        id,
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
        blocks.push({
          id: diffId,
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
