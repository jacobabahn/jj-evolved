import { StyledText, bold, fg, type TextChunk } from "@opentui/core";
import type { Theme } from "./theme";

export type Shortcut = readonly [keys: string, label: string];
// Shortcuts are listed in priority order; those that do not fit the width are dropped from the end.
export type ShortcutLine = { left: Shortcut[]; right?: Shortcut[] };

const gap = "  ";
const width = ([keys, label]: Shortcut) => keys.length + 1 + label.length;
const span = (items: Shortcut[]) => items.reduce((total, item, index) => total + width(item) + (index ? gap.length : 0), 0);

// Keys read badly with a slash between punctuation (`'/"`), so all-punctuation keys are separated by a space;
// other keys, ctrl keys included, are joined with a slash (`^D/^U`, `Esc/?`). A label that already lists several
// keys (`j/down`) is spaced apart from the next with ` / `. The footer and help both write keys this way.
export function joinKeys(keys: string[]) {
  const punctuation = (key: string) => /^[^a-z0-9]$/i.test(key);
  if (keys.some(key => key.length > 1 && key.includes("/"))) return keys.join(" / ");
  return keys.join(keys.every(punctuation) ? " " : "/");
}
export function keyPair(first: string, second: string) {
  return joinKeys([first, second]);
}

export function shortcutBar(lines: ShortcutLine[], columns: number, colors: Theme): StyledText {
  const chunks: TextChunk[] = [];
  const pairs = (items: Shortcut[]) => items.flatMap(([keys, label], index) => [
    ...(index ? [fg(colors.muted)(gap)] : []), bold(fg(colors.accent)(keys)), fg(colors.muted)(` ${label}`),
  ]);
  lines.forEach(({ left, right = [] }, index) => {
    const pinned = right.length ? span(right) + gap.length : 0;
    const shown: Shortcut[] = [];
    for (const item of left) if (span([...shown, item]) + pinned <= columns) shown.push(item); else break;
    if (index) chunks.push(fg(colors.muted)("\n"));
    chunks.push(...pairs(shown));
    if (!right.length) return;
    chunks.push(fg(colors.muted)(" ".repeat(Math.max(shown.length ? gap.length : 0, columns - span(shown) - span(right)))), ...pairs(right));
  });
  return new StyledText(chunks);
}
