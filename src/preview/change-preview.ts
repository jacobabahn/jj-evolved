import { getTheme } from "../ui/theme";
import { highlightJjText } from "../ui/jj-highlighting";
import { BoxRenderable, DiffRenderable, SyntaxStyle, TextRenderable, pathToFiletype, type RenderContext } from "@opentui/core";
import { terminalText } from "../terminal-text";

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
  set content(value: string) {
    this.value = terminalText(value);
    for (const child of this.getChildren()) child.destroyRecursively();
    const sections = this.value.split(/(?=^diff --git )/m);
    for (const [index, section] of sections.entries()) {
      const id = `${this.id}-${index}`;
      const path = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ?? /^--- a\/(.+)$/m.exec(section)?.[1];
      if (!section.startsWith("diff --git ") || !/^@@ /m.test(section)) {
        this.add(new TextRenderable(this.ctx, { id, width: "100%", content: highlightJjText(section.replace(/\n$/, ""), this.prefixes, getTheme(this.ctx)), fg: getTheme(this.ctx).text, wrapMode: "word", flexShrink: 0 }));
        continue;
      }
      const headerEnd = section.search(/^@@ /m);
      const header = section.slice(0, headerEnd);
      this.add(new TextRenderable(this.ctx, { id: `${id}-header`, width: "100%", content: header.trimEnd(), fg: getTheme(this.ctx).muted, wrapMode: "word", flexShrink: 0 }));
      for (const [hunkIndex, hunk] of section.slice(headerEnd).split(/(?=^@@ )/m).entries()) {
        const heading = hunk.split("\n")[0] ?? "";
        this.add(new TextRenderable(this.ctx, { id: `${id}-hunk-${hunkIndex}`, width: "100%", content: heading, fg: getTheme(this.ctx).hunk, wrapMode: "word", flexShrink: 0 }));
        this.add(new DiffRenderable(this.ctx, {
          id: `${id}-diff-${hunkIndex}`, width: "100%", diff: header + hunk, filetype: pathToFiletype(path ?? ""), syntaxStyle: this.syntax,
          lineNumberFg: getTheme(this.ctx).muted, lineNumberBg: getTheme(this.ctx).bg,
          addedLineNumberBg: getTheme(this.ctx).addedBg, removedLineNumberBg: getTheme(this.ctx).removedBg,
          view: "unified", showLineNumbers: true, wrapMode: "word", flexShrink: 0,
          fg: getTheme(this.ctx).text, addedBg: getTheme(this.ctx).addedBg, removedBg: getTheme(this.ctx).removedBg, contextBg: getTheme(this.ctx).bg,
          addedContentBg: getTheme(this.ctx).addedBg, removedContentBg: getTheme(this.ctx).removedBg, contextContentBg: getTheme(this.ctx).bg,
          addedSignColor: getTheme(this.ctx).added, removedSignColor: getTheme(this.ctx).conflict,
        }));
        if (hunk.includes("\\ No newline at end of file")) {
          this.add(new TextRenderable(this.ctx, { id: `${id}-newline-${hunkIndex}`, content: "\\ No newline at end of file", fg: getTheme(this.ctx).muted, flexShrink: 0 }));
        }
      }
    }
  }

  override destroy() {
    super.destroy();
    this.syntax.destroy();
  }
}
