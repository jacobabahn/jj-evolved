import { expect, test } from "bun:test";
import { demoText } from "../scripts/demo-text";
import { defaultBindings, presets } from "../src/ui/keybindings";

test("the demo's instructions name the default keys", () => {
  const text = demoText(defaultBindings);
  expect(text.multiline).toContain("Press Enter on this change to edit its description");
  expect(text.multiline).toContain("^S saves");
  expect(text.descriptionsDoc).toContain("D, or Space → Describe in editor");
  expect(text.controls).toContain("j/k: browse changes\nr: rebase a change\nS: squash changes");
  // The keys jj-evolved used before it adopted jjui's defaults.
  for (const stale of ["Press d ", "Enter to save", "R: rebase", "Edit description in editor"]) {
    expect(Object.values(text).join("\n")).not.toContain(stale);
  }
});

test("the demo's instructions follow the preset they are written for", () => {
  expect(demoText(presets.legacy).multiline).toContain("Press d on this change");
  expect(demoText(presets.legacy).controls).toContain("R: rebase a change");
});
