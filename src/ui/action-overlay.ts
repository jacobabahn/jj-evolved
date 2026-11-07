import { getTheme } from "./theme";
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { terminalText } from "../terminal-text";
import type { ShortcutLine } from "./shortcut-bar";

export class ActionOverlay extends BoxRenderable {
  onError?: (message: string) => void;
  readonly context: TextRenderable;
  readonly fields: BoxRenderable;
  readonly feedback: TextRenderable;
  readonly body: BoxRenderable;
  // The overlay's keys are shown in the app footer rather than inside the overlay.
  onKeys?: () => void;
  private shortcuts: ShortcutLine = { left: [] };
  private rows: number | `${number}%` = "84%";

  constructor(ctx: RenderContext, id: string) {
    super(ctx, {
      id, position: "absolute",
      zIndex: 20, border: true, borderColor: getTheme(ctx).accent, backgroundColor: getTheme(ctx).panel,
      flexDirection: "column",
    });
    this.context = new TextRenderable(ctx, { id: `${id}-source`, height: 2, flexShrink: 0, fg: getTheme(this.ctx).muted, truncate: true });
    this.fields = new BoxRenderable(ctx, { id: `${id}-fields`, flexDirection: "column", flexShrink: 0 });
    this.feedback = new TextRenderable(ctx, { id: `${id}-feedback`, height: 2, flexShrink: 0, fg: getTheme(this.ctx).muted, visible: false });
    this.body = new BoxRenderable(ctx, { id: `${id}-body`, marginBottom: 1, height: 0, flexGrow: 1, minHeight: 1, flexDirection: "column" });
    for (const child of [this.context, this.fields, this.feedback, this.body]) this.add(child);
    this.place(this.rows);
    ctx.on("resize", () => this.place(this.rows));
  }

  /**
   * Sets the overlay's height and centres it on the screen, 84% wide with equal side margins.
   * Geometry is in whole cells: a fractional percentage width lets text inputs inside draw past the border.
   */
  place(rows: number | `${number}%`) {
    this.rows = rows;
    const { width, height } = this.ctx;
    const margin = Math.round(width * 0.08);
    const tall = Math.min(height, typeof rows === "number" ? rows : Math.round(height * Number.parseFloat(rows) / 100));
    this.left = margin;
    this.width = Math.max(1, width - 2 * margin);
    this.height = tall;
    this.top = Math.floor((height - tall) / 2);
  }

  get keys(): ShortcutLine { return this.shortcuts; }
  set keys(keys: ShortcutLine) {
    this.shortcuts = keys;
    this.onKeys?.();
  }

  applyTheme() {
    const colors = getTheme(this.ctx);
    this.borderColor = colors.accent;
    this.backgroundColor = colors.panel;
    this.context.fg = this.feedback.fg = colors.muted;
  }

  report(message: string, error = false) {
    if (error) this.onError?.(message);
    this.feedback.visible = Boolean(message);
    this.feedback.fg = error ? getTheme(this.ctx).conflict : getTheme(this.ctx).muted;
    this.feedback.content = terminalText(message);
  }
}
