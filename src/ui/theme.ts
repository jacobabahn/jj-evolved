import { RGBA, type ColorInput, type RenderContext } from "@opentui/core";

export const darkTheme = {
  bg: "#101820", panel: "#15212c", text: "#d6e2eb", muted: "#91a6b7",
  accent: "#6ed6bd", border: "#344958", selected: "#294a51", graphSelected: "#294a51", selectedText: "#ffffff",
  drop: "#435d38", commit: "#7dcfff", changeId: "#c4a7e7", bookmark: "#e6c384",
  conflict: "#ffad9e", number: "#e5a478", property: "#a9c7ef", operator: "#b6c5d3",
  hunk: "#9ebdf5", addedBg: "#18382e", removedBg: "#402a2b", added: "#8cddb0", mode: "#e6c384",
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
  },
  dark: darkTheme,
  light: {
    bg: "#ffffff", panel: "#f1f5f9", text: "#172b3a", muted: "#526575",
    accent: "#006b59", border: "#94a3b8", selected: "#cbdff2", graphSelected: "#cbdff2", selectedText: "#172b3a",
    drop: "#cce8c2", commit: "#005a9c", changeId: "#7540a0", bookmark: "#825500",
    conflict: "#b42318", number: "#934b12", property: "#245780", operator: "#405466",
    hunk: "#345da7", addedBg: "#e2f3e5", removedBg: "#fbe5e5", added: "#176b36", mode: "#825500",
  },
  gruvbox: {
    bg: "#282828", panel: "#282828", text: "#ebdbb2", muted: "#a89984",
    accent: "#8ec07c", border: "#665c54", selected: "#504945", graphSelected: "#504945", selectedText: "#fbf1c7",
    drop: "#3c482d", commit: "#83a598", changeId: "#d3869b", bookmark: "#fabd2f",
    conflict: "#fb4934", number: "#fe8019", property: "#83a598", operator: "#a89984",
    hunk: "#83a598", addedBg: "#323b26", removedBg: "#442b28", added: "#b8bb26", mode: "#fabd2f",
  },
  tokyonight: {
    bg: "#1a1b26", panel: "#16161e", text: "#c0caf5", muted: "#a9b1d6",
    accent: "#7dcfff", border: "#414868", selected: "#292e42", graphSelected: "#292e42", selectedText: "#c0caf5",
    drop: "#283b3d", commit: "#7aa2f7", changeId: "#bb9af7", bookmark: "#e0af68",
    conflict: "#f7768e", number: "#ff9e64", property: "#73daca", operator: "#89ddff",
    hunk: "#7aa2f7", addedBg: "#20332d", removedBg: "#3b2637", added: "#9ece6a", mode: "#e0af68",
  },
  catppuccin: {
    bg: "#1e1e2e", panel: "#181825", text: "#cdd6f4", muted: "#a6adc8",
    accent: "#94e2d5", border: "#585b70", selected: "#45475a", graphSelected: "#45475a", selectedText: "#cdd6f4",
    drop: "#34463b", commit: "#89b4fa", changeId: "#cba6f7", bookmark: "#f9e2af",
    conflict: "#f38ba8", number: "#fab387", property: "#89dceb", operator: "#bac2de",
    hunk: "#89b4fa", addedBg: "#2b3835", removedBg: "#402d3e", added: "#a6e3a1", mode: "#f9e2af",
  },
  vesper: {
    bg: "#101010", panel: "#161616", text: "#ffffff", muted: "#a0a0a0",
    accent: "#ffc799", border: "#505050", selected: "#232323", graphSelected: "#232323", selectedText: "#ffc799",
    drop: "#263c35", commit: "#99ffe4", changeId: "#ffc799", bookmark: "#ffffff",
    conflict: "#ff8080", number: "#ffc799", property: "#99ffe4", operator: "#a0a0a0",
    hunk: "#ffc799", addedBg: "#1b2421", removedBg: "#241919", added: "#99ffe4", mode: "#99ffe4",
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

const contextThemes = new WeakMap<RenderContext, Theme>();

export function setTheme(context: RenderContext, theme: Theme) {
  contextThemes.set(context, theme);
}

export function getTheme(context: RenderContext): Theme {
  return contextThemes.get(context) ?? themes.terminal;
}
