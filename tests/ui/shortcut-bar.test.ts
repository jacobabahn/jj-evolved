import { expect, test } from "bun:test";
import { keyPair, shortcutBar } from "../../src/ui/shortcut-bar";
import { themes } from "../../src/ui/theme";

const text = (bar: ReturnType<typeof shortcutBar>) => bar.chunks.map(chunk => chunk.text).join("");

test("key pairs use a slash except between two punctuation keys", () => {
  expect(keyPair("j", "k")).toBe("j/k");
  expect(keyPair("^D", "^U")).toBe("^D/^U");
  expect(keyPair("PgDn", "PgUp")).toBe("PgDn/PgUp");
  expect(keyPair("Esc", "?")).toBe("Esc/?");
  expect(keyPair("'", '"')).toBe("' \"");
  expect(keyPair("[", "]")).toBe("[ ]");
});

test("shortcuts drop from the end of the left group while the right group stays pinned", () => {
  const bar = shortcutBar([{ left: [["j/k", "move"], ["L", "revset"], ["/", "search"]], right: [["Esc", "cancel"]] }], 30, themes.dark);
  expect(text(bar)).toBe("j/k move  L revset  Esc cancel");
  expect(text(shortcutBar([{ left: [["j/k", "move"]], right: [["Esc", "cancel"]] }], 30, themes.dark))).toBe(`j/k move${" ".repeat(12)}Esc cancel`);
});
