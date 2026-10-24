import { StyledText, bold, fg, type TextChunk } from "@opentui/core";
import type { Theme } from "./theme";

export type Shortcut = readonly [keys: string, label: string];
// Shortcuts are listed in priority order; those that do not fit the width are dropped from the end.
export type ShortcutLine = { left: Shortcut[]; right?: Shortcut[] };

const gap = "  ";
const width = ([keys, label]: Shortcut) => keys.length + 1 + label.length;
const span = (items: Shortcut[]) => items.reduce((total, item, index) => total + width(item) + (index ? gap.length : 0), 0);

// Pairs of punctuation keys read badly with a slash (`'/"`), so they are separated by a space instead;
// every other pair, ctrl keys included, is joined with a slash (`^D/^U`, `Esc/?`).
export function keyPair(first: string, second: string) {
  const punctuation = (key: string) => /^[^a-z0-9]$/i.test(key);
  return punctuation(first) && punctuation(second) ? `${first} ${second}` : `${first}/${second}`;
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
