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
};

export class PreviewSession {
  private request = 0;
  private disposed = false;

  constructor(private readonly render: (content: PreviewContent) => void) {}

  show(content: PreviewContent) {
    this.cancel();
    if (!this.disposed) this.render({ ...content, text: terminalText(content.text) });
  }

  async load({ target, title, loading, read, prefix = "", empty = "", errorTitle = "Preview error" }: PreviewRequest) {
    if (this.disposed) return;
    this.show({ target, title, text: prefix + loading });
    const request = this.request;
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

  cancel() { ++this.request; }
  dispose() { this.disposed = true; this.cancel(); }
}
