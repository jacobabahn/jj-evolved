import { TextareaRenderable } from "@opentui/core";
import { expect, test } from "bun:test";
import { withUiFixture } from "../../tooling/ui";
import { descriptionEditor } from "../description-editor";

for (const mode of ["save", "unchanged", "fail"] as const) {
  test(`description editor ${mode} preserves selection and restores keyboard input`, () => withUiFixture(`description-${mode}`, async ui => {
    const original = "Initial feature\n\nOriginal body with café and 日本語.\n";
    const replacement = "Edited feature\n\nDetailed explanation with café and 日本語.\n";
    await ui.f.jj("describe", "feature", "-m", original);
    const editor = await descriptionEditor(ui.f, replacement);
    try {
      await Bun.write(editor.mode, mode);
      ui.key("/");
      await ui.prompt("feature");
      const before = await ui.repo.operationId();
      ui.key(" ");
      ui.choose("Edit description in editor");
      await ui.until(mode === "fail" ? "Description editor did not complete" : "Ready.");
      expect(await Bun.file(editor.original).text()).toContain(original);
      expect((await ui.repo.snapshot("feature")).revisions[0]?.description).toBe(mode === "save" ? replacement : original);
      expect(ui.screen.captureCharFrame()).toContain("revset: feature");
      if (mode !== "save") expect(await ui.repo.operationId()).toBe(before);
      ui.key("d");
      await ui.until("Shift/Alt+Enter newline");
      expect((ui.node("description-input") as TextareaRenderable).plainText).toBe((mode === "save" ? replacement : original).trimEnd());
      ui.key("ESCAPE");
      await Bun.sleep(60);
      ui.key("?");
      await ui.until("Keyboard reference");
    } finally { await editor.cleanup(); }
  }), 15_000);
}

test("description editor rejects stale selection before launching the editor", () => withUiFixture("description-stale", async ui => {
  const revision = (await ui.repo.snapshot("@")).revisions[0]!;
  const editor = await descriptionEditor(ui.f, "Must not apply\n");
  try {
    await ui.f.jj("describe", "-m", "Changed externally");
    await expect(ui.repo.editDescription(revision)).rejects.toThrow("selected revision has changed");
    expect(await Bun.file(editor.original).exists()).toBe(false);
    expect((await ui.repo.snapshot("@")).revisions[0]?.description.trim()).toBe("Changed externally");
  } finally { await editor.cleanup(); }
}), 15_000);
