import { terminalText } from "../terminal-text";

// keepScroll marks a reload of what the pane already shows, so the pane keeps its scroll position.
export type PreviewContent = { text: string; title: string; target: "main" | "overlay"; keepScroll?: boolean };
type PreviewRequest = {
  target: PreviewContent["target"];
  title: string;
  loading: string;
  read: () => Promise<string>;
  prefix?: string;
  empty?: string;
  errorTitle?: string;
  cached?: string;
  delay?: number;
  // Identifies what the preview shows. Reloading the key already on screen keeps the old text up until the new text arrives.
  key?: string;
};

export class PreviewSession {
  private request = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake = () => {};
  private shown: Partial<Record<PreviewContent["target"], string>> = {};

  constructor(private readonly render: (content: PreviewContent) => void) {}

  show(content: PreviewContent, key?: string) {
    this.cancel();
    this.shown[content.target] = key;
    if (!this.disposed) this.render({ ...content, text: terminalText(content.text) });
  }

  async load({ target, title, loading, read, prefix = "", empty = "", errorTitle = "Preview error", cached, delay = 0, key }: PreviewRequest) {
    if (this.disposed) return;
    const reload = key !== undefined && this.shown[target] === key ? { keepScroll: true } : {};
    if (cached !== undefined) { this.show({ target, title, text: prefix + (cached.trim() ? cached : empty), ...reload }, key); return; }
    if (reload.keepScroll) this.cancel(); else this.show({ target, title, text: prefix + loading }, key);
    const request = this.request;
    if (delay > 0) {
      await new Promise<void>(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, delay); });
      if (this.disposed || request !== this.request) return;
    }
    try {
      const text = await read();
      if (!this.disposed && request === this.request) {
        this.render({ target, title, text: terminalText(prefix + (text.trim() ? text : empty)), ...reload });
      }
    } catch (error) {
      if (!this.disposed && request === this.request) {
        this.render({ target, title: errorTitle, text: terminalText(prefix + (error instanceof Error ? error.message : String(error))), ...reload });
      }
    }
  }

  cancel() { ++this.request; clearTimeout(this.timer); this.wake(); }
  dispose() { this.disposed = true; this.cancel(); }
}
