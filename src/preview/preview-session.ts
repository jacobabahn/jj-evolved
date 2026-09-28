import { terminalText } from "../terminal-text";

export type PreviewContent = { text: string; title: string; target: "main" | "overlay" };
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
};

export class PreviewSession {
  private request = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake = () => {};

  constructor(private readonly render: (content: PreviewContent) => void) {}

  show(content: PreviewContent) {
    this.cancel();
    if (!this.disposed) this.render({ ...content, text: terminalText(content.text) });
  }

  async load({ target, title, loading, read, prefix = "", empty = "", errorTitle = "Preview error", cached, delay = 0 }: PreviewRequest) {
    if (this.disposed) return;
    if (cached !== undefined) { this.show({ target, title, text: prefix + (cached.trim() ? cached : empty) }); return; }
    this.show({ target, title, text: prefix + loading });
    const request = this.request;
    if (delay > 0) {
      await new Promise<void>(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, delay); });
      if (this.disposed || request !== this.request) return;
    }
    try {
      const text = await read();
      if (!this.disposed && request === this.request) {
        this.render({ target, title, text: terminalText(prefix + (text.trim() ? text : empty)) });
      }
    } catch (error) {
      if (!this.disposed && request === this.request) {
        this.render({ target, title: errorTitle, text: terminalText(prefix + (error instanceof Error ? error.message : String(error))) });
      }
    }
  }

  cancel() { ++this.request; clearTimeout(this.timer); this.wake(); }
  dispose() { this.disposed = true; this.cancel(); }
}
