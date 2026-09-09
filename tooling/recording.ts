import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TextAttributes, type CapturedFrame, type RGBA } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";

function color(value: RGBA) {
  return { rgba: value.toInts(), intent: value.intent, slot: value.slot };
}

export function styledFrame(frame: CapturedFrame) {
  return {
    cols: frame.cols, rows: frame.rows, cursor: frame.cursor,
    lines: frame.lines.map(line => line.spans.map(span => ({
      text: span.text, width: span.width, fg: color(span.fg), bg: color(span.bg), attributes: span.attributes,
    }))),
  };
}

export type StyledFrame = ReturnType<typeof styledFrame>;
export type RecordingFrame = { at: number; screen: StyledFrame };
export type Recording = {
  version: 1;
  title: string;
  error: string | null;
  droppedFrames: number;
  frames: RecordingFrame[];
  events: { at: number; label: string }[];
};

export function recordScreen(screen: TestRendererSetup, maxFrames = 240) {
  const started = performance.now();
  const frames: RecordingFrame[] = [];
  const events: Recording["events"] = [];
  let previous = "";
  let droppedFrames = 0;
  function capture() {
    const frame = styledFrame(screen.captureSpans());
    const serialized = JSON.stringify(frame);
    if (serialized === previous) return;
    previous = serialized;
    frames.push({ at: Math.round(performance.now() - started), screen: frame });
    if (frames.length > maxFrames) { frames.shift(); droppedFrames++; }
  }
  screen.renderer.on("frame", capture);
  return {
    capture,
    mark(label: string, checkpoint = false) {
      events.push({ at: checkpoint ? frames.at(-1)?.at ?? 0 : Math.round(performance.now() - started), label });
      if (events.length > 1000) events.shift();
    },
    stop: () => screen.renderer.off("frame", capture),
    snapshot(title: string, error: unknown = null): Recording {
      return { version: 1, title, error: error === null ? null : error instanceof Error ? error.stack ?? error.message : String(error), droppedFrames, frames: [...frames], events: [...events] };
    },
  };
}

export async function writeRecording(directory: string, recordings: Recording[]) {
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "recording.json"), JSON.stringify(recordings, null, 2));
  const viewer = await Bun.file(join(import.meta.dir, "viewer.js")).text();
  const data = JSON.stringify({ recordings, attributes: TextAttributes }).replaceAll("<", "\\u003c");
  await Bun.write(join(directory, "index.html"), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>jj-evolved · UI recordings</title>
<style>
body{margin:0;background:#101820;color:#d6e2eb;font:15px system-ui}header,main{padding:20px;max-width:1400px;margin:auto}h1{font-size:22px;margin:0 0 12px}p{color:#91a6b7}nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap}button,select{font:inherit;padding:7px;background:#15212c;color:#d6e2eb;border:1px solid #516574;border-radius:4px}input{flex:1;min-width:180px}#viewport{overflow:auto;border:1px solid #344958;padding:12px}#screen{margin:0;display:inline-block;font:14px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;font-variant-ligatures:none}#error{white-space:pre-wrap;color:#ffad9e}#events{max-height:180px;overflow:auto}a{color:#6ed6bd}output{font-variant-numeric:tabular-nums}
</style>
<header><h1>jj-evolved UI recordings</h1><p>Recorded OpenTUI frames. Select a scenario, scrub through changes, or play with the original timing.</p>
<nav><label>Scenario <select id="scenario"></select></label><button id="play" type="button">Play</button><label for="frame">Frame</label><input id="frame" type="range" min="0" value="0" aria-label="Recorded frame"><output id="position"></output></nav></header>
<main><p id="details"></p><div id="viewport"><pre id="screen" aria-label="Terminal screen"></pre></div><pre id="error"></pre><details><summary>Scenario actions</summary><ol id="events"></ol></details></main>
<script id="recordings" type="application/json">${data}</script><script>${viewer}</script></html>`);
  return join(directory, "index.html");
}
