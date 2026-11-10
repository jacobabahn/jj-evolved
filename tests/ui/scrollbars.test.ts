import { expect, test } from "bun:test";
import { RGBA, parseColor, type ScrollBoxRenderable } from "@opentui/core";
import { scrollbarColors, themes, themeNames } from "../../src/ui/theme";
import { withUiFixture } from "../../tooling/ui";

// OpenTUI's own scroll bar: a near-black track and a light grey thumb, whatever the theme.
const opentuiTrack = RGBA.fromHex("#252527"), opentuiThumb = RGBA.fromHex("#9a9ea3");

for (const name of themeNames) {
  test(`${name} scroll bars take their colours from the theme`, () => {
    const theme = themes[name];
    for (const background of [theme.bg, theme.panel]) {
      const { track, thumb } = scrollbarColors(theme, background);
      expect(track).not.toEqual(opentuiTrack);
      expect(thumb).not.toEqual(opentuiThumb);
      expect(thumb).not.toEqual(track);
      // A track that is not the pane's own background is only a faint step from it.
      if (track.intent === "rgb") expect(Math.abs(track.r - parseColor(background).r)).toBeLessThan(0.2);
      else expect(track).toEqual(parseColor(background));
    }
  });
}

test("every scroll box is themed at start and follows a live theme change", () => withUiFixture("scrollbars", async ui => {
  const bars = (id: string) => (ui.node(id) as ScrollBoxRenderable).verticalScrollBar.slider;
  const expectThemed = (theme: (typeof themes)[keyof typeof themes]) => {
    for (const [id, background] of [["revisions", theme.panel], ["preview", theme.bg], ["overlay-preview", theme.panel]] as const) {
      const { track, thumb } = scrollbarColors(theme, background);
      expect({ id, track: bars(id).backgroundColor, thumb: bars(id).foregroundColor }).toEqual({ id, track, thumb });
    }
  };
  ui.key("t");
  await ui.until("Previewing Dark");
  expectThemed(themes.dark);
  ui.key("j");
  await ui.until("Previewing Light");
  expectThemed(themes.light);
  ui.key("RETURN");
  await ui.until("Change preview");
  ui.key("l");
  await ui.until("files of");
  const { track, thumb } = scrollbarColors(themes.light, themes.light.panel);
  expect([bars("changed-files").backgroundColor, bars("changed-files").foregroundColor]).toEqual([track, thumb]);
}, { theme: "dark" }), 15_000);
