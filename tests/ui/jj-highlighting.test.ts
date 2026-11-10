import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { highlightJjText } from "../../src/ui/jj-highlighting";
import { themes } from "../../src/ui/theme";

const colors = themes.dark;
const colorOf = (text: string, part: string) => highlightJjText(text, new Map(), colors).chunks.find(chunk => chunk.text.trim() === part)?.fg;

// The graph marks a conflicted change "! conflict"; preview trees and the preview's metadata use the same marker.
test("a conflict is marked ! conflict in the conflict colour in trees and in the preview's metadata", () => {
  for (const text of ["×  qwrtyuok [feature] ! conflict", "! conflict", "Working copy  ! conflict"]) {
    expect({ text, fg: colorOf(text, "! conflict") }).toEqual({ text, fg: RGBA.fromHex(colors.conflict) });
  }
  // Brackets mark bookmarks, so a bookmark named like the old marker stays a bookmark.
  expect(colorOf("○  qwrtyuok [conflict]", "[conflict]")).toEqual(RGBA.fromHex(colors.bookmark));
});
