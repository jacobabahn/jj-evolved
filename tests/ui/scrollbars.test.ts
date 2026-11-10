import { expect, spyOn, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createApp } from "../../src/app";
import { Repository } from "../../src/repository/repository";
import { fixture } from "../fixture";
import { parseColor, type RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { scrollbarColors, themes, themeNames, type Theme } from "../../src/ui/theme";
import { withUiFixture, type UiFixture } from "../../tooling/ui";

const distance = (a: RGBA, b: RGBA) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

for (const name of themeNames) {
  test(`${name} scroll bars: a faint track over the pane and a thumb that stands out from it`, () => {
    const theme = themes[name];
    for (const background of [theme.bg, theme.panel].map(color => parseColor(color))) {
      const { track, thumb } = scrollbarColors(theme, background);
      if (background.intent !== "rgb") {
        // The terminal's own colours cannot be mixed: the track is the background and the thumb the border colour.
        expect([track, thumb]).toEqual([background, parseColor(theme.border)]);
        continue;
      }
      expect(distance(track, background)).toBeGreaterThan(0);
      expect(distance(track, background)).toBeLessThan(0.15);
      expect(distance(thumb, track)).toBeGreaterThan(0.15);
    }
  });
}

// Both bars of a scroll box, against the colours for the background it is drawn on.
function expectThemed(ui: UiFixture, id: string, theme: Theme, background: "bg" | "panel") {
  const box = ui.node(id) as ScrollBoxRenderable;
  const { track, thumb } = scrollbarColors(theme, theme[background]);
  for (const bar of [box.verticalScrollBar, box.horizontalScrollBar]) {
    expect({ id, track: bar.slider.backgroundColor, thumb: bar.slider.foregroundColor }).toEqual({ id, track, thumb });
  }
}

// Light is not the theme picker's first entry, so nothing here runs a theme change before the first checks.
test("scroll boxes are themed from the start, in forms opened later, and after a live theme change", () => withUiFixture("scrollbars", async ui => {
  await ui.until("Empty change.");
  expectThemed(ui, "revisions", themes.light, "panel");
  expectThemed(ui, "preview", themes.light, "bg");
  ui.key("l");
  await ui.until("files of");
  expectThemed(ui, "changed-files", themes.light, "panel");
  ui.key("ESCAPE");
  await ui.until("─ Revisions ─");
  ui.key(" ");
  await ui.until("Actions");
  ui.choose("Rebase");
  await ui.until("Destination: Choose a revision");
  expectThemed(ui, "history-preview", themes.light, "panel");
  ui.key("ESCAPE");
  await ui.until("Empty change.");
  ui.key("t");
  await ui.until("Previewing Light");
  expectThemed(ui, "overlay-preview", themes.light, "panel");
  ui.key("k");
  await ui.until("Previewing Dark");
  for (const [id, background] of [["revisions", "panel"], ["preview", "bg"], ["overlay-preview", "panel"]] as const) {
    expectThemed(ui, id, themes.dark, background);
  }
}, { theme: "light" }), 15_000);

// A terminal that never answers the palette query never triggers a theme change, so the bars must be themed when built.
test("scroll bars are themed when the terminal does not report its colours", async () => {
  const f = await fixture();
  const screen = await createTestRenderer({ width: 80, height: 24 });
  spyOn(screen.renderer, "getPalette").mockReturnValue(new Promise(() => {}));
  const app = createApp(screen.renderer, await Repository.open(f.path), themes.light);
  try {
    await app.start();
    await screen.renderOnce();
    for (const [id, background] of [["revisions", "panel"], ["preview", "bg"], ["overlay-preview", "panel"]] as const) {
      const box = screen.renderer.root.findDescendantById(id) as ScrollBoxRenderable;
      const { track, thumb } = scrollbarColors(themes.light, themes.light[background]);
      expect({ id, track: box.verticalScrollBar.slider.backgroundColor, thumb: box.verticalScrollBar.slider.foregroundColor }).toEqual({ id, track, thumb });
    }
  } finally {
    app.stop();
    screen.renderer.destroy();
    await f.cleanup();
  }
});
