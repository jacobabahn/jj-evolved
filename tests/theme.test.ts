import { expect, test } from "bun:test";
import { TextRenderable, DiffRenderable, parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { ActionOverlay } from "../src/action-overlay";
import { ChangePreview } from "../src/change-preview";
import { getTheme, setTheme, themes, themeNames } from "../src/theme";

test("terminal defaults retain terminal color intent", () => {
  expect(themes.terminal.bg.intent).toBe("default");
  expect(themes.terminal.text.intent).toBe("default");
  expect(themes.terminal.accent.intent).toBe("indexed");
  expect(themes.terminal.accent.slot).toBe(6);
});

for (const name of themeNames) {
  test(`${name} theme renders dialogs, syntax and diff gutters`, async () => {
    const screen = await createTestRenderer({ width: 90, height: 35 });
    const theme = themes[name];
    setTheme(screen.renderer, theme);
    const overlay = new ActionOverlay(screen.renderer, "theme-dialog");
    const preview = new ChangePreview(screen.renderer, "theme-preview",
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n');
    overlay.body.add(preview);
    overlay.context.content = "Theme preview";
    overlay.report("An error", true);
    screen.renderer.root.add(overlay);
    try {
      await screen.waitForVisualIdle();
      expect(overlay.backgroundColor).toEqual(parseColor(theme.panel));
      expect(overlay.feedback.fg).toEqual(parseColor(theme.conflict));
      const diff = preview.getChildren().find(child => child instanceof DiffRenderable);
      if (!(diff instanceof DiffRenderable)) throw new Error("Missing diff");
      expect(diff.lineNumberBg).toEqual(parseColor(theme.bg));
      expect(screen.captureCharFrame()).toContain("const a = 2;");
      preview.content = "Change qwrtyuok";
      await screen.waitForVisualIdle();
      const text = preview.getChildren().find(child => child instanceof TextRenderable);
      expect(text?.fg).toEqual(parseColor(theme.text));
    } finally {
      screen.renderer.destroy();
    }
  });
}

test("themes belong to each renderer", async () => {
  const first = await createTestRenderer({ width: 40, height: 10 });
  const second = await createTestRenderer({ width: 40, height: 10 });
  try {
    setTheme(first.renderer, themes.light);
    expect(getTheme(first.renderer)).toBe(themes.light);
    expect(getTheme(second.renderer)).toBe(themes.terminal);
  } finally {
    first.renderer.destroy();
    second.renderer.destroy();
  }
});

test("the theme picker previews, cancels and saves without changing the selected revision", async () => {
  const { fixture } = await import("./fixture");
  const { Repository } = await import("../src/repository");
  const { createApp } = await import("../src/app");
  const { SelectRenderable, BoxRenderable } = await import("@opentui/core");
  const { themeNames, themeLabels } = await import("../src/theme");
  const f = await fixture();
  const screen = await createTestRenderer({ width: 100, height: 35 });
  const saved: string[] = [];
  const app = createApp(screen.renderer, await Repository.open(f.path), themes.terminal, async name => { saved.push(name); });
  try {
    await app.start();
    screen.mockInput.pressKey("j");
    await screen.waitForVisualIdle();
    const log = screen.renderer.root.findDescendantById("revisions");
    const before = screen.captureCharFrame().split("\n").find(line => line.includes("▶"));
    const root = screen.renderer.root.findDescendantById("app");
    if (!(root instanceof BoxRenderable)) throw new Error("Missing app");
    screen.mockInput.pressKey("t");
    const chooser = screen.renderer.root.findDescendantById("action-choices");
    if (!(chooser instanceof SelectRenderable)) throw new Error("Missing theme picker");
    for (const name of themeNames) {
      expect(chooser.getSelectedOption()?.name).toBe(`${themeLabels[name]}${name === "terminal" ? "  (current)" : ""}`);
      await screen.waitForVisualIdle();
      expect(root.backgroundColor).toEqual(parseColor(themes[name].bg));
      expect(getTheme(screen.renderer)).toBe(themes[name]);
      const sample = screen.renderer.root.findDescendantById("overlay-preview-text");
      const diff = sample?.getChildren().find(child => child instanceof DiffRenderable);
      expect(diff?.lineNumberBg).toEqual(parseColor(themes[name].bg));
      expect(screen.captureCharFrame()).toContain("Theme preview");
      if (name === "terminal") {
        const lines = screen.captureCharFrame().split("\n");
        const first = lines.findIndex(line => line.includes("Terminal  (current)"));
        expect(first).toBeGreaterThanOrEqual(0);
        for (const [index, themeName] of themeNames.entries()) {
          expect(lines[first + index]).toContain(themeLabels[themeName]);
        }
      }
      expect(screen.renderer.root.findDescendantById("revisions")).toBe(log);
      screen.mockInput.pressKey("j");
    }
    screen.mockInput.pressEscape();
    await screen.waitForVisualIdle();
    expect(getTheme(screen.renderer)).toBe(themes.terminal);
    expect(screen.captureCharFrame().split("\n").find(line => line.includes("▶"))).toBe(before);
    expect(saved).toEqual([]);
    screen.mockInput.pressKey("t");
    for (let i = 0; i < themeNames.indexOf("gruvbox"); i++) screen.mockInput.pressKey("j");
    screen.mockInput.pressEnter();
    await screen.waitForVisualIdle();
    expect(saved).toEqual(["gruvbox"]);
    expect(getTheme(screen.renderer)).toBe(themes.gruvbox);
    expect(screen.captureCharFrame()).toContain("Theme: Gruvbox Dark");
    screen.mockInput.pressKey("t");
    expect(chooser.getSelectedOption()?.name).toBe("Gruvbox Dark  (current)");
    screen.mockInput.pressKey("j");
    screen.mockInput.pressEscape();
    await screen.waitForVisualIdle();
    expect(getTheme(screen.renderer)).toBe(themes.gruvbox);
  } finally {
    app.stop();
    screen.renderer.destroy();
    await f.cleanup();
  }
});

test("failed theme saves stay in the picker and Escape restores the previous theme", async () => {
  const { fixture } = await import("./fixture");
  const { Repository } = await import("../src/repository");
  const { createApp } = await import("../src/app");
  const f = await fixture();
  const screen = await createTestRenderer({ width: 100, height: 30 });
  const app = createApp(screen.renderer, await Repository.open(f.path), themes.light, async () => { throw new Error("Read-only config"); });
  try {
    await app.start();
    screen.mockInput.pressKey("t");
    screen.mockInput.pressKey("j");
    screen.mockInput.pressEnter();
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain("Read-only config");
    screen.mockInput.pressEscape();
    await screen.waitForVisualIdle();
    for (let attempt = 0; attempt < 30 && getTheme(screen.renderer) !== themes.light; attempt++) {
      await Bun.sleep(10);
      await screen.renderOnce();
    }
    expect(getTheme(screen.renderer)).toBe(themes.light);
  } finally {
    app.stop();
    screen.renderer.destroy();
    await f.cleanup();
  }
});
