import { expect, test } from "bun:test";
import { InputRenderable, TextAttributes, rgbToHex } from "@opentui/core";
import { revsetErrorFeedback } from "../src/app";
import { themes } from "../src/ui/theme";
import { withUiFixture } from "../tooling/ui";

const syntaxError = "Error: Failed to parse revset: Syntax error\nCaused by:  --> 1:23\n  |\n1 | bookmarks(main) | foo(\n  |                       ^---\n  |\n  = expected <strict_identifier> or <expression>\nHint: See the docs";

test("a revset syntax error points at its column under the field, with jj's note and the error", () => {
  const query = "bookmarks(main) | foo(";
  expect(revsetErrorFeedback(syntaxError, query, 2, 76)).toBe(`${" ".repeat(24)}^--- expected <strict_identifier> or <expression>\nFailed to parse revset: Syntax error`);
  // The note is cut to the caret's row, so the error line below it always shows.
  expect(revsetErrorFeedback(syntaxError, query, 2, 40)).toBe(`${" ".repeat(24)}^--- expected <…\nFailed to parse revset: Syntax error`);
  // jj counts characters; wide ones take two cells in the field.
  expect(revsetErrorFeedback(syntaxError.replace("1:23", "1:5"), "日本語 | foo(", 0, 76).split("\n")[0]).toMatch(/^ {7}\^---/);
  // A query wider than the field scrolls, so the column goes into the message.
  expect(revsetErrorFeedback(syntaxError, `${"x".repeat(90)}(`, 2, 76)).toBe("Failed to parse revset: Syntax error at column 23: expected <strict_identifier> or <expression>");
  expect(revsetErrorFeedback("Error: Revision `nope` doesn't exist", "nope")).toBe("Error: Revision `nope` doesn't exist");
});

test("the revset prompt opens on the active revset, and typing replaces it while moving the cursor keeps it", () => withUiFixture("revset-prefill", async ui => {
  await ui.until("Empty change.");
  const input = () => ui.node("prompt-input") as InputRenderable;
  // The colour the field draws its text in, read from the screen.
  const fieldColor = (text: string) => {
    const line = ui.screen.captureSpans().lines.find(row => row.spans.some(span => span.text.includes("›")))!;
    return rgbToHex(line.spans.find(span => span.text.startsWith(text))!.fg);
  };
  ui.key("L");
  await ui.until("› builtin_log()");
  expect(fieldColor("builtin_log()")).toBe(themes.dark.muted);
  await ui.type("@");
  expect(input().value).toBe("@");
  await ui.settled();
  expect(fieldColor("@")).toBe(themes.dark.text);
  ui.key("ESCAPE");
  await ui.until("Empty change.");
  ui.key("L");
  await ui.until("› builtin_log()");
  ui.key("END");
  await ui.type(" & mine()");
  expect(input().value).toBe("builtin_log() & mine()");
  // Backspace edits the revset rather than replacing it, and a paste replaces it as typing does.
  for (const [act, value] of [[() => ui.key("BACKSPACE"), "builtin_log("], [() => ui.paste("mine()"), "mine()"]] as const) {
    ui.key("ESCAPE");
    await ui.until("Empty change.");
    ui.key("L");
    await ui.until("› builtin_log()");
    await act();
    await ui.settled();
    expect(input().value).toBe(value);
  }
  // Long text stays inside the overlay's border.
  await ui.type("x".repeat(120));
  await ui.settled();
  const box = ui.node("action-overlay");
  const row = ui.screen.captureCharFrame().split("\n").find(line => line.includes("›"))!;
  expect(Array.from(row)[box.screenX + box.width - 1]).toBe("│");
}, { theme: "dark" }), 15_000);

test("text fields show a glyph, and help writes keys as the footer does", () => withUiFixture("fields-and-help", async ui => {
  await ui.until("Empty change.");
  ui.key("?");
  await ui.until("Help · ");
  const frame = ui.screen.captureCharFrame();
  expect(frame).toContain("j/k, down/up");
  expect(frame).toContain("q/^C");
  expect(frame).not.toContain("j/down / k/up");
  const key = ui.screen.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.startsWith("j/k, down/up"));
  expect(rgbToHex(key!.fg)).toBe(themes.dark.accent);
  expect(key!.attributes & TextAttributes.BOLD).toBeTruthy();
  ui.key("ESCAPE");
  for (let attempt = 0; attempt < 150 && ui.screen.renderer.root.findDescendantById("action-overlay")?.visible; attempt++) { await ui.settled(); await Bun.sleep(10); }
  ui.key(" ");
  await ui.until("── Edit ──");
  ui.key("/");
  await ui.until("/ Filter actions by name");
}, { theme: "dark", width: 120, height: 40 }), 15_000);
