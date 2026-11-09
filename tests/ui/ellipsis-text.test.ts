import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable } from "@opentui/core";
import { EllipsisText, fitText } from "../../src/ui/ellipsis-text";

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

