import { expect, test } from "bun:test";
import { CodeRenderable, DiffRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { ChangePreview } from "../src/change-preview";

const patch = `diff --git a/hello.ts b/hello.ts
--- a/hello.ts
+++ b/hello.ts
@@ -1,1 +1,3 @@
-export const greeting = "old";
+export const greeting = "hello";
+
+const count = 42;
@@ -20,1 +22,1 @@
-const end = false;
+const end = true;
`;

test("previews highlight code, keep source blank lines and render every file and hunk", async () => {
  const screen = await createTestRenderer({ width: 90, height: 35 });
  const preview = new ChangePreview(screen.renderer, "test-preview", `A change\n\n${patch}${patch.replaceAll("hello.ts", "other.ts")}`);
  screen.renderer.root.add(preview);
  try {
    await screen.renderOnce();
    const diffs = preview.getChildren().filter(child => child instanceof DiffRenderable);
    expect(diffs).toHaveLength(4);
    for (const diff of diffs) {
      const code = diff.findDescendantById(`${diff.id}-left-code`);
      if (!(code instanceof CodeRenderable)) throw new Error("Missing highlighted code");
      await code.highlightingDone;
      expect(code.filetype).toBe("typescript");
      expect(code.getLineHighlights(0).length).toBeGreaterThan(0);
    }
    await screen.waitForVisualIdle();
    const frame = screen.captureCharFrame();
    expect(frame).toContain("+++ b/hello.ts");
    expect(frame).toContain("+++ b/other.ts");
    expect(frame.match(/@@ -20,1 \+22,1 @@/g)).toHaveLength(2);
    const lines = frame.split("\n");
    const greeting = lines.findIndex(line => line.includes('+ export const greeting = "hello";'));
    expect(greeting).toBeGreaterThan(0);
    expect(lines[greeting + 1]?.trim()).toMatch(/^2\s+\+$/);
    expect(lines[greeting + 2]).toContain("+ const count = 42;");
    const spans = screen.captureSpans().lines.flatMap(line => line.spans);
    const keyword = spans.find(span => span.text.trim() === "export");
    const string = spans.find(span => span.text.includes('"hello"'));
    expect(keyword).toBeDefined();
    expect(string).toBeDefined();
    expect(keyword?.fg).not.toEqual(string?.fg);
    preview.content = "Empty change. No file differences.";
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain("Empty change.");
    expect(screen.captureCharFrame()).not.toContain("greeting");
  } finally { preview.destroyRecursively(); screen.renderer.destroy(); }
}, 20_000);

test("unknown files, binary changes and terminal controls remain readable", async () => {
  const screen = await createTestRenderer({ width: 80, height: 20 });
  const preview = new ChangePreview(screen.renderer, "fallback", `${patch.replaceAll("hello.ts", "hello.unknown")}diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n`);
  screen.renderer.root.add(preview);
  try {
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain('greeting = "hello"');
    expect(screen.captureCharFrame()).toContain("Binary files a/image.png and b/image.png differ");
    preview.content = "Status\u001b[31m\nReady\n";
    expect(preview.content).not.toContain("\u001b");
    await screen.waitForVisualIdle();
    expect(preview.height).toBe(2);
  } finally { preview.destroyRecursively(); screen.renderer.destroy(); }
});
