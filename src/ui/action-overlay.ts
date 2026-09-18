import { getTheme } from "./theme";
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { terminalText } from "../terminal-text";

export class ActionOverlay extends BoxRenderable {
  readonly context: TextRenderable;
  readonly fields: BoxRenderable;
  readonly feedback: TextRenderable;
  readonly body: BoxRenderable;
  readonly hints: TextRenderable;

  constructor(ctx: RenderContext, id: string) {
    super(ctx, {
      id, position: "absolute", left: "12%", top: "8%", width: "82%", height: "84%",
      zIndex: 20, border: true, borderColor: getTheme(ctx).accent, backgroundColor: getTheme(ctx).panel,
      flexDirection: "column",
    });
    this.context = new TextRenderable(ctx, { id: `${id}-source`, height: 2, flexShrink: 0, fg: getTheme(this.ctx).muted, truncate: true });
    this.fields = new BoxRenderable(ctx, { id: `${id}-fields`, flexDirection: "column", flexShrink: 0 });
    this.feedback = new TextRenderable(ctx, { id: `${id}-feedback`, height: 2, flexShrink: 0, fg: getTheme(this.ctx).muted, visible: false });
    this.body = new BoxRenderable(ctx, { id: `${id}-body`, marginBottom: 1, height: 0, flexGrow: 1, minHeight: 1, flexDirection: "column" });
    this.hints = new TextRenderable(ctx, { id: `${id}-hints`, height: 1, flexShrink: 0, fg: getTheme(this.ctx).accent, truncate: true });
    for (const child of [this.context, this.fields, this.feedback, this.body, this.hints]) this.add(child);
  }

  applyTheme() {
    const colors = getTheme(this.ctx);
    this.borderColor = colors.accent;
    this.backgroundColor = colors.panel;
    this.context.fg = this.feedback.fg = colors.muted;
    this.hints.fg = colors.accent;
  }

  report(message: string, error = false) {
    this.feedback.visible = Boolean(message);
    this.feedback.fg = error ? getTheme(this.ctx).conflict : getTheme(this.ctx).muted;
    this.feedback.content = terminalText(message);
  }
}
