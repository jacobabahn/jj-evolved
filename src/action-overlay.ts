import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { terminalText } from "./repository";

export class ActionOverlay extends BoxRenderable {
  readonly context: TextRenderable;
  readonly fields: BoxRenderable;
  readonly feedback: TextRenderable;
  readonly body: BoxRenderable;
  readonly hints: TextRenderable;

  constructor(ctx: RenderContext, id: string) {
    super(ctx, {
      id, position: "absolute", left: "12%", top: "8%", width: "82%", height: "84%",
      zIndex: 20, border: true, borderColor: "#6ed6bd", backgroundColor: "#15212c",
      flexDirection: "column",
    });
    this.context = new TextRenderable(ctx, { id: `${id}-source`, height: 2, flexShrink: 0, fg: "#91a6b7", truncate: true });
    this.fields = new BoxRenderable(ctx, { id: `${id}-fields`, flexDirection: "column", flexShrink: 0 });
    this.feedback = new TextRenderable(ctx, { id: `${id}-feedback`, height: 2, flexShrink: 0, fg: "#91a6b7", visible: false });
    this.body = new BoxRenderable(ctx, { id: `${id}-body`, height: 0, flexGrow: 1, minHeight: 1, flexDirection: "column" });
    this.hints = new TextRenderable(ctx, { id: `${id}-hints`, height: 1, flexShrink: 0, fg: "#6ed6bd", truncate: true });
    for (const child of [this.context, this.fields, this.feedback, this.body, this.hints]) this.add(child);
  }

  report(message: string, error = false) {
    this.feedback.visible = Boolean(message);
    this.feedback.fg = error ? "#ffad9e" : "#91a6b7";
    this.feedback.content = terminalText(message);
  }
}
