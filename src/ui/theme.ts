import { RGBA, hexToRgb, parseColor, type ColorInput, type RenderContext, type TerminalColors } from "@opentui/core";

export const darkTheme = {
  bg: "#101820", panel: "#15212c", text: "#d6e2eb", muted: "#91a6b7",
  accent: "#6ed6bd", border: "#344958", selected: "#294a51", graphSelected: "#294a51", selectedText: "#ffffff",
  drop: "#435d38", commit: "#7dcfff", changeId: "#c4a7e7", bookmark: "#e6c384",
  conflict: "#ffad9e", number: "#e5a478", property: "#a9c7ef", operator: "#b6c5d3",
  hunk: "#9ebdf5", addedBg: "#18382e", removedBg: "#402a2b", added: "#8cddb0", mode: "#e6c384",
  addedGutter: "#3b6a55", removedGutter: "#79514e", addedSign: "#8cddb0", removedSign: "#ffad9e",
};
export type Theme = { readonly [K in keyof typeof darkTheme]: ColorInput };

export const themes = {
  terminal: {
    bg: RGBA.defaultBackground(), panel: RGBA.defaultBackground(),
    text: RGBA.defaultForeground(), muted: RGBA.fromIndex(8),
    accent: RGBA.fromIndex(6), border: RGBA.fromIndex(8),
    selected: RGBA.fromIndex(4), graphSelected: RGBA.defaultBackground(), selectedText: RGBA.fromIndex(15), drop: RGBA.defaultBackground(),
    commit: RGBA.fromIndex(4), changeId: RGBA.fromIndex(5), bookmark: RGBA.fromIndex(3),
    conflict: RGBA.fromIndex(1), number: RGBA.fromIndex(3), property: RGBA.fromIndex(6),
    operator: RGBA.defaultForeground(), hunk: RGBA.fromIndex(4),
    addedBg: RGBA.defaultBackground(), removedBg: RGBA.defaultBackground(), added: RGBA.fromIndex(2), mode: RGBA.fromIndex(3),
    addedGutter: RGBA.fromIndex(2), removedGutter: RGBA.fromIndex(1), addedSign: RGBA.defaultForeground(), removedSign: RGBA.defaultForeground(),
  },
  dark: darkTheme,
  light: {
    bg: "#ffffff", panel: "#f1f5f9", text: "#172b3a", muted: "#526575",
    accent: "#006b59", border: "#94a3b8", selected: "#cbdff2", graphSelected: "#cbdff2", selectedText: "#172b3a",
    drop: "#cce8c2", commit: "#005a9c", changeId: "#7540a0", bookmark: "#825500",
    conflict: "#b42318", number: "#934b12", property: "#245780", operator: "#405466",
    hunk: "#345da7", addedBg: "#e2f3e5", removedBg: "#fbe5e5", added: "#176b36", mode: "#825500",
    addedGutter: "#a5cab1", removedGutter: "#e6aba8", addedSign: "#176b36", removedSign: "#b42318",
  },
  gruvbox: {
    bg: "#282828", panel: "#282828", text: "#ebdbb2", muted: "#a89984",
    accent: "#8ec07c", border: "#665c54", selected: "#504945", graphSelected: "#504945", selectedText: "#fbf1c7",
    drop: "#3c482d", commit: "#83a598", changeId: "#d3869b", bookmark: "#fabd2f",
    conflict: "#fb4934", number: "#fe8019", property: "#83a598", operator: "#a89984",
    hunk: "#83a598", addedBg: "#323b26", removedBg: "#442b28", added: "#b8bb26", mode: "#fabd2f",
    addedGutter: "#5a6126", removedGutter: "#7b342c", addedSign: "#b8bb26", removedSign: "#fb4934",
  },
  tokyonight: {
    bg: "#1a1b26", panel: "#16161e", text: "#c0caf5", muted: "#a9b1d6",
    accent: "#7dcfff", border: "#414868", selected: "#292e42", graphSelected: "#292e42", selectedText: "#c0caf5",
    drop: "#283b3d", commit: "#7aa2f7", changeId: "#bb9af7", bookmark: "#e0af68",
    conflict: "#f7768e", number: "#ff9e64", property: "#73daca", operator: "#89ddff",
    hunk: "#7aa2f7", addedBg: "#20332d", removedBg: "#3b2637", added: "#9ece6a", mode: "#e0af68",
    addedGutter: "#46623f", removedGutter: "#733e51", addedSign: "#9ece6a", removedSign: "#f7768e",
  },
  catppuccin: {
    bg: "#1e1e2e", panel: "#181825", text: "#cdd6f4", muted: "#a6adc8",
    accent: "#94e2d5", border: "#585b70", selected: "#45475a", graphSelected: "#45475a", selectedText: "#cdd6f4",
    drop: "#34463b", commit: "#89b4fa", changeId: "#cba6f7", bookmark: "#f9e2af",
    conflict: "#f38ba8", number: "#fab387", property: "#89dceb", operator: "#bac2de",
    hunk: "#89b4fa", addedBg: "#2b3835", removedBg: "#402d3e", added: "#a6e3a1", mode: "#f9e2af",
    addedGutter: "#506b55", removedGutter: "#76495e", addedSign: "#a6e3a1", removedSign: "#f38ba8",
  },
  vesper: {
    bg: "#101010", panel: "#161616", text: "#ffffff", muted: "#a0a0a0",
    accent: "#ffc799", border: "#505050", selected: "#232323", graphSelected: "#232323", selectedText: "#ffc799",
    drop: "#263c35", commit: "#99ffe4", changeId: "#ffc799", bookmark: "#ffffff",
    conflict: "#ff8080", number: "#ffc799", property: "#99ffe4", operator: "#a0a0a0",
    hunk: "#ffc799", addedBg: "#1b2421", removedBg: "#241919", added: "#99ffe4", mode: "#99ffe4",
    addedGutter: "#41665c", removedGutter: "#663838", addedSign: "#99ffe4", removedSign: "#ff8080",
  },
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof themes;

export const themeLabels = {
  terminal: "Terminal", dark: "Dark", light: "Light", gruvbox: "Gruvbox Dark",
  tokyonight: "Tokyo Night", catppuccin: "Catppuccin Mocha", vesper: "Vesper",
} satisfies Record<ThemeName, string>;

export const themeNames = Object.keys(themes).map(parseThemeName);

export function parseThemeName(value: string): ThemeName {
  switch (value) {
      case "terminal": case "dark": case "light": case "gruvbox":
      case "tokyonight": case "catppuccin": case "vesper": return value;
  }
  throw new Error(`Unknown theme "${value}". Choose ${Object.keys(themes).join(", ")}.`);
}

// A theme that selects with the panel colour (Terminal, until the terminal reports its colors) has no selection band,
// so the cursor bar is lighter and the text bolds instead.
export function hasSelectionBand(theme: Theme) {
  return !parseColor(theme.graphSelected).equals(parseColor(theme.panel));
}

export function cursorBar(theme: Theme) {
  return hasSelectionBand(theme) ? "▌" : "┃";
}

const contextThemes = new WeakMap<RenderContext, { selected: Theme; resolved: Theme }>();
const contextTerminalColors = new WeakMap<RenderContext, TerminalColors>();

// The terminal palette has no faint shades, so the selection band mixes the terminal's reported background toward
// its foreground, and diff line tints toward its green and red. A terminal that does not report its colors keeps
// the thin cursor bar and untinted lines beside the gutter.
function withTerminalTints(theme: Theme, colors: TerminalColors | undefined): Theme {
  const background = colors?.defaultBackground, foreground = colors?.defaultForeground;
  const red = colors?.palette[1], green = colors?.palette[2];
  if (theme !== themes.terminal || !background) return theme;
  const band = foreground ? { graphSelected: mix(background, foreground, 0.15) } : {};
  const tints = red && green ? { addedBg: mix(background, green, 0.2), removedBg: mix(background, red, 0.2) } : {};
  return foreground || (red && green) ? { ...theme, ...band, ...tints } : theme;
}

function mix(from: string, to: string, amount: number) {
  const a = hexToRgb(from), b = hexToRgb(to);
  return RGBA.fromValues(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount);
}

export function setTheme(context: RenderContext, theme: Theme) {
  contextThemes.set(context, { selected: theme, resolved: withTerminalTints(theme, contextTerminalColors.get(context)) });
}

export function setTerminalColors(context: RenderContext, colors: TerminalColors) {
  contextTerminalColors.set(context, colors);
  const theme = contextThemes.get(context);
  if (theme) setTheme(context, theme.selected);
}

export function getTheme(context: RenderContext): Theme {
  return contextThemes.get(context)?.resolved ?? themes.terminal;
}
