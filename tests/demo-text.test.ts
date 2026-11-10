import { expect, test } from "bun:test";
import { demoText } from "../scripts/demo-text";
import { keymap, loadKeybindings, presets } from "../src/ui/keybindings";

const all = (text: ReturnType<typeof demoText>) => Object.values(text).join("\n");

test("the demo's instructions name the default keys", () => {
  const text = demoText(keymap(presets.jjui).scopes);
  expect(text.multiline).toContain("Press Enter on this change to edit its description");
  expect(text.multiline).toContain("^S saves");
  expect(text.descriptionsDoc).toContain("D, or Space → Describe in editor,");
  expect(text.controls).toContain("j/k: browse changes\nr: rebase a change\nS: squash changes");
  // The keys jj-evolved used before it adopted jjui's defaults.
  for (const stale of ["Press d ", "Enter to save", "R: rebase", "Edit description in editor"]) expect(all(text)).not.toContain(stale);
});

test("the demo's instructions follow the configured keys, and name a menu entry for an action with none", () => {
  const legacy = demoText(loadKeybindings({ preset: "legacy" }).scopes);
  expect(legacy.multiline).toContain("Press d on this change");
  expect(legacy.controls).toContain("R: rebase a change");
  // legacy has no key for the external editor.
  expect(legacy.descriptionsDoc).toContain("Space → Describe in editor opens");
  expect(all(legacy)).not.toContain("unbound");
  const custom = demoText(loadKeybindings({ bindings: { describe: [], rebase: ["ctrl+b"] }, scopes: { prompt: { saveDescription: ["ctrl+g"] } } }).scopes);
  expect(custom.multiline).toContain("Press Space → Describe on this change");
  expect(custom.multiline).toContain("^G saves");
  expect(custom.controls).toContain("^B: rebase a change");
});

test("the demo builds its instructions with demoText", async () => {
  const script = await Bun.file(new URL("../scripts/demo.ts", import.meta.url)).text();
  expect(script).toContain("demoText(");
  expect(script).not.toMatch(/Press \w+ on this change/);
});
