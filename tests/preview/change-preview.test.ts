import { expect, test } from "bun:test";
import { BoxRenderable, CodeRenderable, DiffRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { ChangePreview, highlightLimits } from "../../src/preview/change-preview";

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

test("operation notes and source leftovers remain visible after a diff", async () => {
  const screen = await createTestRenderer({ width: 100, height: 35 });
  const preview = new ChangePreview(screen.renderer, "absorb-summary",
    `${patch}\nChanged working copy:\nA rewritten change\n\nRemaining in source:\nEmpty change. No file differences remain.`);
  screen.renderer.root.add(preview);
  try {
    await screen.waitForVisualIdle();
    const frame = screen.captureCharFrame();
    expect(frame).toContain("Changed working copy:");
    expect(frame).toContain("Remaining in source:");
    expect(frame).toContain("No file differences remain.");
    expect(frame).toContain('+ const end = true;');
  } finally { preview.destroyRecursively(); screen.renderer.destroy(); }
});

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

test("repeated text keeps every child, and a changed hunk updates in place without dropping its highlighting", async () => {
  const screen = await createTestRenderer({ width: 90, height: 35 });
  const preview = new ChangePreview(screen.renderer, "reconcile", `A change\n\n${patch}`);
  screen.renderer.root.add(preview);
  const code = (diff: DiffRenderable) => {
    const value = diff.findDescendantById(`${diff.id}-left-code`);
    if (!(value instanceof CodeRenderable)) throw new Error("Missing highlighted code");
    return value;
  };
  try {
    await screen.renderOnce();
    const [first, second] = preview.getChildren().filter(child => child instanceof DiffRenderable);
    await code(first!).highlightingDone;
    await code(second!).highlightingDone;
    await screen.waitForVisualIdle();
    const children = preview.getChildren();
    const before = JSON.stringify(screen.captureSpans());
    preview.content = `A change\n\n${patch}`;
    await screen.renderOnce();
    expect(preview.getChildren()).toEqual(children);
    expect(JSON.stringify(screen.captureSpans())).toBe(before);

    preview.content = `A change\n\n${patch.replace("const end = true;", "const end = 1;")}`;
    expect(preview.getChildren()).toEqual(children);
    expect(first!.diff).not.toContain("const end = 1;");
    expect(second!.diff).toContain("const end = 1;");
    await screen.renderOnce();
    // Until the new highlight lands, the hunk keeps its previous styled text instead of drawing it unstyled.
    expect(code(second!).getLineHighlights(1).length).toBeGreaterThan(0);
    await code(second!).highlightingDone;
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain("+ const end = 1;");
  } finally { preview.destroyRecursively(); screen.renderer.destroy(); }
}, 20_000);

test("hunks past the highlight limits keep diff colours, lose syntax colours and say why", async () => {
  const file = (name: string, count: number) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${count} @@\n`
    + Array.from({ length: count }, (_, index) => `+export const value${index} = ${index};\n`).join("");
  const screen = await createTestRenderer({ width: 100, height: 40 });
  const saved = { ...highlightLimits };
  // Hunk patches are 146 (5 lines), 277 (10) and 557 (20) characters. long.ts is over the budget on its own, small.ts and
  // after.ts still fit after it, and late.ts would fit alone but not in what is left. notes.unknown has no grammar.
  Object.assign(highlightLimits, { totalChars: 500 });
  const preview = new ChangePreview(screen.renderer, "limits", `${file("small.ts", 5)}${file("long.ts", 20)}${file("after.ts", 5)}${file("late.ts", 10)}${file("notes.unknown", 50)}`);
  screen.renderer.root.add(preview);
  try {
    await screen.renderOnce();
    const diffs = preview.getChildren().filter(child => child instanceof DiffRenderable);
    expect(diffs.map(diff => diff.filetype)).toEqual(["typescript", undefined, "typescript", undefined, undefined]);
    const headers = preview.getChildren().filter(child => /-hunk-\d+$/.test(child.id)).map(child => child instanceof TextRenderable ? child.plainText : "");
    expect(headers).toEqual(["@@ -0,0 +1,5 @@", "@@ -0,0 +1,20 @@  (diff too large to highlight)", "@@ -0,0 +1,5 @@", "@@ -0,0 +1,10 @@  (diff too large to highlight)", "@@ -0,0 +1,50 @@"]);
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain("+ export const value10 = 10;");
  } finally {
    Object.assign(highlightLimits, saved);
    preview.destroyRecursively(); screen.renderer.destroy();
  }
}, 20_000);

const addedFile = (name: string, count: number) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${count} @@\n`
  + Array.from({ length: count }, (_, index) => `+export const value${index} = ${index};\n`).join("");
const hunkHeaders = (preview: ChangePreview) =>
  preview.getChildren().filter(child => /-hunk-\d+$/.test(child.id)).map(child => child instanceof TextRenderable ? child.plainText : "");
const highlighted = async (diff: DiffRenderable) => {
  const code = diff.findDescendantById(`${diff.id}-left-code`);
  if (!(code instanceof CodeRenderable)) throw new Error("Missing highlighted code");
  await code.highlightingDone;
  return code.getLineHighlights(0).length > 0;
};

test("files whose language has no parser neither spend the highlight budget nor say they were skipped", async () => {
  const screen = await createTestRenderer({ width: 100, height: 40 });
  const saved = { ...highlightLimits };
  // Patches are 277 (10 lines) and 557 (20) characters. lock.json is over the budget alone and vendor.py would leave too
  // little for app.ts, but neither has a parser, so app.ts gets the whole budget.
  Object.assign(highlightLimits, { totalChars: 500 });
  const preview = new ChangePreview(screen.renderer, "no-parser", `${addedFile("lock.json", 20)}${addedFile("vendor.py", 10)}${addedFile("app.ts", 10)}`);
  screen.renderer.root.add(preview);
  try {
    await screen.renderOnce();
    const diffs = preview.getChildren().filter(child => child instanceof DiffRenderable);
    expect(diffs.map(diff => diff.filetype)).toEqual([undefined, undefined, "typescript"]);
    expect(hunkHeaders(preview)).toEqual(["@@ -0,0 +1,20 @@", "@@ -0,0 +1,10 @@", "@@ -0,0 +1,10 @@"]);
    expect(await highlighted(diffs[2]!)).toBe(true);
  } finally {
    Object.assign(highlightLimits, saved);
    preview.destroyRecursively(); screen.renderer.destroy();
  }
}, 20_000);

test("a refresh highlights a hunk that now fits the budget and skips one that no longer does", async () => {
  const screen = await createTestRenderer({ width: 100, height: 40 });
  const saved = { ...highlightLimits };
  // Two 277-character patches exceed 500 together, unless the first is a file with no parser.
  Object.assign(highlightLimits, { totalChars: 500 });
  const over = `${addedFile("first.ts", 10)}${addedFile("app.ts", 10)}`;
  const fits = `${addedFile("first.json", 10)}${addedFile("app.ts", 10)}`;
  const preview = new ChangePreview(screen.renderer, "refresh", over);
  screen.renderer.root.add(preview);
  const app = () => preview.getChildren().filter(child => child instanceof DiffRenderable)[1]!;
  try {
    await screen.renderOnce();
    expect(app().filetype).toBeUndefined();
    expect(hunkHeaders(preview)[1]).toBe("@@ -0,0 +1,10 @@  (diff too large to highlight)");

    preview.content = fits;
    await screen.renderOnce();
    expect(app().filetype).toBe("typescript");
    expect(hunkHeaders(preview)[1]).toBe("@@ -0,0 +1,10 @@");
    expect(await highlighted(app())).toBe(true);
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).not.toContain("too large to highlight");

    preview.content = over;
    await screen.renderOnce();
    expect(app().filetype).toBeUndefined();
    expect(hunkHeaders(preview)[1]).toBe("@@ -0,0 +1,10 @@  (diff too large to highlight)");
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain("too large to highlight");
  } finally {
    Object.assign(highlightLimits, saved);
    preview.destroyRecursively(); screen.renderer.destroy();
  }
}, 20_000);

// A preview inside a scroll box the way the app holds it, so only blocks near the viewport get renderables.
const scrolled = async (text: string, { width = 80, height = 20 } = {}) => {
  const screen = await createTestRenderer({ width, height });
  const box = new ScrollBoxRenderable(screen.renderer, { id: "preview", width: "100%", height: "100%", scrollY: true, contentOptions: { width: "100%", minHeight: 0 } });
  const preview = new ChangePreview(screen.renderer, "window", text);
  box.add(preview);
  screen.renderer.root.add(box);
  await screen.renderOnce();
  await screen.renderOnce();
  return { screen, box, preview, close: () => { box.destroyRecursively(); screen.renderer.destroy(); } };
};
const plainFile = (index: number, count: number) => `diff --git a/file${index}.txt b/file${index}.txt\n--- a/file${index}.txt\n+++ b/file${index}.txt\n@@ -0,0 +1,${count} @@\n`
  + Array.from({ length: count }, (_, line) => `+file ${index} line ${line}\n`).join("");
// The last column holds the scroll bar, whose thumb moves as the view scrolls.
const visible = (screen: Awaited<ReturnType<typeof createTestRenderer>>) => screen.captureCharFrame().split("\n").map(line => line.slice(0, -1));

test("a long diff keeps renderables only near the viewport and the full scroll extent", async () => {
  // 300 files of 3 header rows, a hunk header and 10 lines: 4,200 rows and 900 blocks, none of them wrapping.
  const { screen, box, preview, close } = await scrolled(Array.from({ length: 300 }, (_, index) => plainFile(index, 10)).join(""));
  try {
    expect(box.scrollHeight).toBe(300 * 14);
    expect(preview.getChildren().length).toBeLessThan(30);
    expect(screen.captureCharFrame()).toContain("+++ b/file0.txt");

    box.scrollTo(150 * 14);
    await screen.renderOnce();
    expect(visible(screen)[0]).toContain("diff --git a/file150.txt");
    expect(preview.getChildren().length).toBeLessThan(30);
    expect(preview.getRenderable("window-1-diff-0")).toBeUndefined();

    box.scrollTo(box.scrollHeight);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("+ file 299 line 9");
    expect(box.scrollHeight).toBe(300 * 14);
  } finally { close(); }
}, 20_000);

test("scrolling moves the text one row at a time while blocks above the viewport are created with their real heights", async () => {
  // Word wrapping breaks these lines into more rows than an estimate by characters expects, so each block above the
  // viewport is taller than assumed until it is created.
  const words = Array.from({ length: 6 }, (_, word) => `${word}`.padEnd(30, "w")).join(" ");
  const file = (index: number) => `diff --git a/f${index}.txt b/f${index}.txt\n--- a/f${index}.txt\n+++ b/f${index}.txt\n@@ -0,0 +1,4 @@\n`
    + Array.from({ length: 4 }, (_, line) => `+${index}:${line} ${words}\n`).join("");
  const { screen, box, close } = await scrolled(Array.from({ length: 120 }, (_, index) => file(index)).join(""), { width: 50, height: 16 });
  try {
    const estimated = box.scrollHeight;
    box.scrollTo(box.scrollHeight);
    await screen.renderOnce();
    await screen.renderOnce();
    let before = visible(screen);
    for (let step = 0; step < 80; step++) {
      box.scrollBy(-1);
      await screen.renderOnce();
      const after = visible(screen);
      expect(after.slice(1, 15)).toEqual(before.slice(0, 14));
      before = after;
    }
    // The blocks created on the way up were taller than estimated.
    expect(box.scrollHeight).toBeGreaterThan(estimated);
  } finally { close(); }
}, 30_000);

test("a reload keeps the scroll position and updates a hunk in view in place", async () => {
  const files = Array.from({ length: 200 }, (_, index) => plainFile(index, 10));
  const { screen, box, preview, close } = await scrolled(files.join(""));
  try {
    box.scrollTo(100 * 14 + 4);
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    expect(frame).toContain("+ file 100 line 0");
    const diff = preview.getRenderable("window-100-diff-0");
    expect(diff).toBeInstanceOf(DiffRenderable);

    // What followPreview does: set the text, wait a frame, then restore the old position.
    const top = box.scrollTop;
    preview.content = files.join("");
    await screen.renderOnce();
    box.scrollTo(top);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toBe(frame);
    expect(preview.getRenderable("window-100-diff-0")).toBe(diff);

    preview.content = files.join("").replace("+file 100 line 2\n", "+file 100 line two\n");
    expect(preview.getRenderable("window-100-diff-0")).toBe(diff);
    await screen.renderOnce();
    box.scrollTo(top);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("+ file 100 line two");
    expect(box.scrollHeight).toBe(200 * 14);
  } finally { close(); }
}, 20_000);

test("the window follows the preview when content above it in the scroll box changes height", async () => {
  // The overlay puts a tree comparison above its preview; hiding it moves the preview up after the window was chosen.
  const screen = await createTestRenderer({ width: 80, height: 20 });
  const box = new ScrollBoxRenderable(screen.renderer, { id: "overlay", width: "100%", height: "100%", scrollY: true, contentOptions: { width: "100%", minHeight: 0 } });
  const above = new BoxRenderable(screen.renderer, { id: "trees", height: 200, flexShrink: 0 });
  const preview = new ChangePreview(screen.renderer, "moved", Array.from({ length: 30 }, (_, index) => plainFile(index, 10)).join(""));
  box.add(above);
  box.add(preview);
  screen.renderer.root.add(box);
  try {
    await screen.renderOnce();
    box.scrollTo(200);
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain("+++ b/file0.txt");
    above.height = 0;
    box.scrollTo(0);
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain("+++ b/file0.txt");
  } finally { box.destroyRecursively(); screen.renderer.destroy(); }
});

test("hunks created while scrolling are as tall as the rows they draw, whatever the width", async () => {
  // Wrapped lines of many lengths: opentui lays a diff's code out a column wider than it measures it at, unless the
  // preview fixes its width, and the hunk then ends in blank rows.
  const line = (index: number) => Array.from({ length: 3 + (index * 7) % 23 }, (_, word) => `w${(index * 31 + word) % 97}`).join(" ");
  const file = (index: number) => `diff --git a/f${index}.rs b/f${index}.rs\n--- a/f${index}.rs\n+++ b/f${index}.rs\n@@ -${index * 300 + 1},80 +${index * 300 + 1},80 @@\n`
    + Array.from({ length: 120 }, (_, row) => `${"+- "[row % 3]}${line(index * 120 + row)}\n`).join("");
  const text = Array.from({ length: 12 }, (_, index) => file(index)).join("");
  for (const width of [72, 81, 88, 97]) {
    const { screen, box, close } = await scrolled(text, { width, height: 30 });
    try {
      for (let step = 0; step < 60; step++) {
        box.scrollBy(step < 30 ? 27 : -27);
        await screen.renderOnce();
        // Every row of a diff starts with a line number or continues a wrapped line; none of them is empty.
        const blank = visible(screen).slice(0, 30).findIndex(row => !row.trim());
        if (blank >= 0 && box.scrollTop + 30 < box.scrollHeight) throw new Error(`blank row ${blank} at width ${width}, scroll ${box.scrollTop}\n${screen.captureCharFrame()}`);
      }
    } finally { close(); }
  }
}, 60_000);
