import { getTheme } from "./theme";
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { terminalText } from "../terminal-text";
import type { ShortcutLine } from "./shortcut-bar";
import { EllipsisText, fitText } from "./ellipsis-text";

/**
 * Narrower than this, an overlay spans the screen: below 120 columns its 8% side margins leave strips of cut-off pane
 * text beside it rather than readable panes.
 */
export const FULL_WIDTH_BELOW = 120;

export class ActionOverlay extends BoxRenderable {
  onError?: (message: string) => void;
  readonly context: TextRenderable;
  readonly fields: BoxRenderable;
  readonly feedback: TextRenderable;
  readonly body: BoxRenderable;
  // The overlay's keys are shown in the app footer rather than inside the overlay.
  onKeys?: () => void;
  /** Called when the overlay opens or closes, so the screen behind it can be dimmed. */
  onVisibility?: (visible: boolean) => void;
  private shortcuts: ShortcutLine = { left: [] };
  private rows: number | `${number}%` = "84%";
  private columns = 1;
  private heading?: string;

  constructor(ctx: RenderContext, id: string) {
    super(ctx, {
      id, position: "absolute",
      zIndex: 20, border: true, borderColor: getTheme(ctx).accent, backgroundColor: getTheme(ctx).panel,
      flexDirection: "column",
    });
    this.context = new EllipsisText(ctx, { id: `${id}-source`, height: 2, flexShrink: 0, fg: getTheme(this.ctx).muted });
    this.fields = new BoxRenderable(ctx, { id: `${id}-fields`, flexDirection: "column", flexShrink: 0 });
    this.feedback = new TextRenderable(ctx, { id: `${id}-feedback`, height: 2, flexShrink: 0, fg: getTheme(this.ctx).muted, visible: false });
    this.body = new BoxRenderable(ctx, { id: `${id}-body`, marginBottom: 1, height: 0, flexGrow: 1, minHeight: 1, flexDirection: "column" });
    for (const child of [this.context, this.fields, this.feedback, this.body]) this.add(child);
    this.place(this.rows);
    ctx.on("resize", () => this.place(this.rows));
  }

  /** The border title, cut with … to the placed width: OpenTUI drops a title that does not fit rather than cutting it. */
  override get title() { return this.heading; }
  override set title(value: string | undefined) {
    this.heading = value;
    this.fitTitle();
  }
  private fitTitle() {
    const text = this.heading?.trim();
    // The border draws "─ " before the title and " ─" after it, inside its corners.
    super.title = text ? ` ${fitText(text, Math.max(1, this.columns - 6))} ` : this.heading;
  }

  override get visible() { return super.visible; }
  override set visible(value: boolean) {
    const changed = value !== super.visible;
    super.visible = value;
    if (changed) this.onVisibility?.(value);
  }

  /**
   * Sets the overlay's height and centres it on the screen, 84% wide with equal side margins, or the full width on a
   * screen narrower than {@link FULL_WIDTH_BELOW} columns.
   * Geometry is in whole cells: a fractional percentage width lets text inputs inside draw past the border.
   */
  place(rows: number | `${number}%`) {
    this.rows = rows;
    const { width, height } = this.ctx;
    const margin = width < FULL_WIDTH_BELOW ? 0 : Math.round(width * 0.08);
    const tall = Math.min(height, typeof rows === "number" ? rows : Math.round(height * Number.parseFloat(rows) / 100));
    this.left = margin;
    this.columns = Math.max(1, width - 2 * margin);
    this.width = this.columns;
    this.height = tall;
    this.top = Math.floor((height - tall) / 2);
    this.fitTitle();
  }

  /** Columns inside the border, known as soon as the overlay is placed rather than after the next layout. */
  get innerWidth() { return Math.max(0, this.columns - 2); }

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
