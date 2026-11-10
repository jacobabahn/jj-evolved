import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, RGBA, StyledText, fg } from "@opentui/core";
import { EllipsisText, fitText } from "../../src/ui/ellipsis-text";
import { homePath } from "../../src/app";

test("fitText keeps the start and ends a cut with one ellipsis column", () => {
  expect(fitText("Validate retry on network failures", 12)).toBe("Validate re…");
  expect(fitText("fits", 4)).toBe("fits");
  expect(fitText("日本語のテキスト", 7)).toBe("日本語…");
  expect(fitText("anything", 0)).toBe("");
});

test("EllipsisText cuts at its own edge and at the edge of a clipping row, and grows back", async () => {
  const screen = await createTestRenderer({ width: 40, height: 3 });
  try {
    const column = new BoxRenderable(screen.renderer, { width: 20, flexDirection: "column" });
    const shrunk = new EllipsisText(screen.renderer, { height: 1, content: "Validate retry on network failures" });
    const row = new BoxRenderable(screen.renderer, { height: 1, width: 20, flexDirection: "row", overflow: "hidden" });
    row.add(new EllipsisText(screen.renderer, { content: "abcdefghij", flexShrink: 0 }));
    row.add(new EllipsisText(screen.renderer, { content: "[login-flow]", marginLeft: 1, flexShrink: 0 }));
    row.add(new EllipsisText(screen.renderer, { content: "[main]", marginLeft: 1, flexShrink: 0 }));
    column.add(shrunk);
    column.add(row);
    screen.renderer.root.add(column);
    await screen.renderOnce();
    const [first, second] = screen.captureCharFrame().split("\n").map(line => line.slice(0, 20));
    expect(first).toBe("Validate retry on n…");
    expect(second).toBe("abcdefghij [login-f…");

    column.width = 40;
    row.width = 40;
    await screen.renderOnce();
    expect(screen.captureCharFrame().split("\n")[0]).toBe("Validate retry on network failures      ");
  } finally {
    screen.renderer.destroy();
  }
});

// Styled text colours its chunks and leaves the renderable's own colour unset, so an … drawn in that colour came out
// in the default white, invisible on the Light theme's pale selection band.
test("EllipsisText draws the … in the colour of the text it replaces", async () => {
  const screen = await createTestRenderer({ width: 20, height: 2 });
  const blue = RGBA.fromHex("#005a9c"), purple = RGBA.fromHex("#7540a0");
  try {
    const text = new EllipsisText(screen.renderer, { width: 10, height: 2,
      content: new StyledText([fg(purple)("abc "), fg(blue)("defghijklmnop\n"), fg(purple)("short")]) });
    screen.renderer.root.add(text);
    await screen.renderOnce();
    expect(screen.captureCharFrame().split("\n")[0]?.slice(0, 10)).toBe("abc defgh…");
    const cut = screen.captureSpans().lines[0]?.spans.find(span => span.text.includes("…"));
    expect(cut?.fg).toEqual(blue);
  } finally {
    screen.renderer.destroy();
  }
});

test("EllipsisText counts a tab as the two columns it is drawn in when colouring the …", async () => {
  const screen = await createTestRenderer({ width: 20, height: 1 });
  const purple = RGBA.fromHex("#7540a0");
  try {
    const text = new EllipsisText(screen.renderer, { width: 10, height: 1, content: new StyledText([fg(purple)("a\tbcdefghi")]) });
    screen.renderer.root.add(text);
    await screen.renderOnce();
    expect(screen.captureSpans().lines[0]?.spans.find(span => span.text.includes("…"))?.fg).toEqual(purple);
  } finally {
    screen.renderer.destroy();
  }
});

test("the header writes a path inside the home directory from ~", () => {
  expect(homePath("/home/me/dev/repo", "/home/me")).toBe("~/dev/repo");
  expect(homePath("/home/me", "/home/me")).toBe("~");
  expect(homePath("/home/meadow/repo", "/home/me")).toBe("/home/meadow/repo");
  expect(homePath("/tmp/repo", "")).toBe("/tmp/repo");
});
