import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { GroupedSelect } from "../../src/ui/grouped-select";

test("a group header is never the last visible row without its first item", async () => {
  const screen = await createTestRenderer({ width: 40, height: 8 });
  try {
    const names = ["── Edit ──", "Describe", "New child", "── History ──", "Rebase", "Squash", "Split"];
    // Two lines per option, so four options fit.
    const list = new GroupedSelect(screen.renderer, { id: "list", width: 40, height: 8, showDescription: true,
      options: names.map(name => ({ name, description: name.startsWith("──") ? "" : `${name} the change` })) });
    list.isHeader = index => names[index]?.startsWith("──") ?? false;
    screen.renderer.root.add(list);
    list.setSelectedIndex(1);
    await screen.renderOnce();
    let frame = screen.captureCharFrame();
    expect(frame).toContain("── History ──");
    expect(frame).toContain("Rebase");
    // Without the nudge this page would end on the header.
    list.setSelectedIndex(2);
    await screen.renderOnce();
    frame = screen.captureCharFrame();
    expect(frame).toContain("── History ──");
    expect(frame).toContain("▶ New child");
    expect(frame).toContain("Rebase");
  } finally {
    screen.renderer.destroy();
  }
});
