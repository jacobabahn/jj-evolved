import { highlightJjText } from "./jj-highlighting";
import { BoxRenderable, DiffRenderable, SyntaxStyle, TextRenderable, pathToFiletype, type RenderContext } from "@opentui/core";
import { terminalText } from "./repository";

export class ChangePreview extends BoxRenderable {
  prefixes: ReadonlyMap<string, string> = new Map();
  private value = "";
  private readonly syntax = SyntaxStyle.fromStyles({
    default: { fg: "#d6e2eb" }, keyword: { fg: "#c4a7e7", bold: true },
    string: { fg: "#e6c384" }, comment: { fg: "#91a6b7", italic: true },
    number: { fg: "#e5a478" }, boolean: { fg: "#e5a478" }, constant: { fg: "#e5a478" },
    function: { fg: "#7dcfff" }, type: { fg: "#6ed6bd" }, property: { fg: "#a9c7ef" },
    operator: { fg: "#b6c5d3" }, punctuation: { fg: "#b6c5d3" },
  });

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
        this.add(new TextRenderable(this.ctx, { id, width: "100%", content: highlightJjText(section.replace(/\n$/, ""), this.prefixes), fg: "#d6e2eb", wrapMode: "word", flexShrink: 0 }));
        continue;
      }
      const headerEnd = section.search(/^@@ /m);
      const header = section.slice(0, headerEnd);
      this.add(new TextRenderable(this.ctx, { id: `${id}-header`, width: "100%", content: header.trimEnd(), fg: "#91a6b7", wrapMode: "word", flexShrink: 0 }));
      for (const [hunkIndex, hunk] of section.slice(headerEnd).split(/(?=^@@ )/m).entries()) {
        const heading = hunk.split("\n")[0] ?? "";
        this.add(new TextRenderable(this.ctx, { id: `${id}-hunk-${hunkIndex}`, width: "100%", content: heading, fg: "#9ebdf5", wrapMode: "word", flexShrink: 0 }));
        this.add(new DiffRenderable(this.ctx, {
          id: `${id}-diff-${hunkIndex}`, width: "100%", diff: header + hunk, filetype: pathToFiletype(path ?? ""), syntaxStyle: this.syntax,
          view: "unified", showLineNumbers: true, wrapMode: "word", flexShrink: 0,
          fg: "#d6e2eb", addedBg: "#18382e", removedBg: "#402a2b", contextBg: "#101820",
          addedContentBg: "#18382e", removedContentBg: "#402a2b", contextContentBg: "#101820",
          addedSignColor: "#8cddb0", removedSignColor: "#ffad9e",
        }));
        if (hunk.includes("\\ No newline at end of file")) {
          this.add(new TextRenderable(this.ctx, { id: `${id}-newline-${hunkIndex}`, content: "\\ No newline at end of file", fg: "#91a6b7", flexShrink: 0 }));
        }
      }
    }
  }

  override destroy() {
    super.destroy();
    this.syntax.destroy();
  }
}
