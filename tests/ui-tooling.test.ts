import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgbToHex, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { scenarios } from "../tooling/scenarios";
import { createUiFixture, withUiFixture, type UiFixture } from "../tooling/ui";
import { recordScreen, writeRecording } from "../tooling/recording";

for (const scenario of scenarios) {
  test(`UI scenario: ${scenario.name}`, () => withUiFixture(scenario.name, scenario.run, { theme: "dark", bindings: scenario.bindings }), 15_000);
}

function matchingStyles(ui: UiFixture, text: string) {
  return ui.screen.captureSpans().lines
    .flatMap(line => line.spans.filter(span => span.text.includes(text)))
    .map(span => ({
      text: span.text, width: span.width, fg: rgbToHex(span.fg), bg: rgbToHex(span.bg), attributes: span.attributes,
    }));
}

for (const width of [80, 120]) {
  test(`styled selection and help layout at ${width} columns`, () => withUiFixture(`snapshots-${width}`, async ui => {
    await ui.until("Empty change.");
    const styles = matchingStyles(ui, "Next change");
    expect(styles).toHaveLength(2);
    expect(styles).toMatchSnapshot(`selected revision ${width}`);
    ui.key("?");
    await ui.until("Keyboard reference");
    const preview = ui.node("preview");
    const text = ui.screen.captureCharFrame().split("\n")
      .slice(preview.screenY, preview.screenY + preview.height)
      .map(line => Array.from(line).slice(preview.screenX, preview.screenX + preview.width).join(""))
      .join("\n");
    expect(text).toMatchSnapshot(`help layout ${width}`);
    expect(matchingStyles(ui, "j/k move")).toMatchSnapshot(`footer styles ${width}`);
  }, { theme: "dark", width, height: 30 }), 15_000);
}

test("element IDs drive clicks and saved targets reject a replaced renderable", () => withUiFixture("targets", async ui => {
  const snapshot = await ui.repo.snapshot("all()");
  const row = snapshot.graph.findIndex(row => row.kind === "description" && row.revision.description.trim() === "Initial feature");
  expect(row).toBeGreaterThanOrEqual(0);
  const target = ui.target(`revision-label-${row}`);
  await ui.click(target);
  await ui.until("+ hello from jj-evolved");
  const header = ui.target("header");
  const old = ui.node(header);
  old.destroyRecursively();
  ui.screen.renderer.root.add(new TextRenderable(ui.screen.renderer, { id: "header", content: "Replacement" }));
  expect(() => ui.node(header)).toThrow("Stale UI target");
  expect(() => ui.node("prompt-input")).toThrow("Hidden UI target");
  expect(ui.inspect().some(element => element.id === "preview" && element.width > 0)).toBe(true);
}), 15_000);

test("renderer recordings retain styled intermediate frames and enforce the retention limit", async () => {
  const screen = await createTestRenderer({ width: 12, height: 2 });
  const recorder = recordScreen(screen, 3);
  const text = new TextRenderable(screen.renderer, { content: "start", fg: "#ff0000" });
  screen.renderer.root.add(text);
  try {
    for (let index = 0; index < 6; index++) {
      text.content = `frame ${index}`;
      await screen.renderOnce();
    }
    const recording = recorder.snapshot("retention");
    expect(recording.frames).toHaveLength(3);
    expect(recording.droppedFrames).toBeGreaterThanOrEqual(3);
    expect(recording.frames[0]?.screen.lines[0]?.map(span => span.text).join("")).toContain("frame 3");
    expect(recording.frames[2]?.screen.lines[0]?.[0]?.fg.rgba).toEqual([255, 0, 0, 255]);
  } finally { recorder.stop(); screen.renderer.destroy(); }
});

test("failed scenarios save a replay, preserve the error, and remove their temporary repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "jj-ui-artifacts-"));
  let repository = "";
  const failure = new Error("deliberate artifact verification");
  try {
    await expect(withUiFixture("failure-check", async ui => {
      repository = ui.f.path;
      ui.key("?");
      await ui.until("Keyboard reference");
      throw failure;
    }, { artifactRoot: root })).rejects.toBe(failure);
    const entries = await readdir(root);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("Missing failure artifact");
    const json = await Bun.file(join(root, entry, "recording.json")).text();
    expect(json).toContain("deliberate artifact verification");
    expect(json).toContain("Keyboard reference");
    const html = await Bun.file(join(root, entry, "index.html")).text();
    expect(html).toContain('id="recordings"');
    expect(html).toContain('id="play"');
    await expect(readdir(repository)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

test("recording HTML keeps terminal text out of executable markup", async () => {
  const root = await mkdtemp(join(tmpdir(), "jj-ui-html-"));
  try {
    const payload = '</script><img src=x onerror="alert(1)">';
    const file = await writeRecording(root, [{ version: 1, title: payload, error: payload, frames: [], events: [], droppedFrames: 0 }]);
    const html = await Bun.file(file).text();
    expect(html).not.toContain(payload);
    expect(html).toContain("\\u003c/script>");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the fixture also accepts Kitty input and releases resources after explicit cleanup", async () => {
  const ui = await createUiFixture({ kittyKeyboard: true });
  const path = ui.f.path;
  try {
    ui.key("?");
    await ui.until("Keyboard reference");
  } finally { await ui.cleanup(); }
  await ui.cleanup();
  await expect(readdir(path)).rejects.toThrow();
});
