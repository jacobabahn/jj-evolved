// Render UI recordings (artifacts/ui/<scenario>/recording.json) to PNG frames and an optional GIF.
// Usage: bun tooling/render.ts <recording-dir-or-json> <output-dir> [--gif] [--all-frames]
// Writes one PNG per checkpoint (events created with ui.capture) plus final.png.
// Frames are drawn by xterm.js (WebGL) so box-drawing lines join like a real terminal.
// Requires the Playwright chrome-headless-shell in ~/.cache/ms-playwright and ffmpeg for --gif.
import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const attributes = { BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, INVERSE: 32, HIDDEN: 64, STRIKETHROUGH: 128 };
type Span = { text: string; width: number; fg: { rgba: number[] }; bg: { rgba: number[] }; attributes: number };
type Frame = { at: number; screen: { cols: number; rows: number; lines: Span[][] } };
type Recording = { title: string; frames: Frame[]; events: { at: number; label: string }[] };

const [source, output, ...flags] = process.argv.slice(2);
if (!source || !output) { console.error("Usage: bun tooling/render.ts <recording-dir-or-json> <output-dir> [--gif] [--all-frames]"); process.exit(1); }
const makeGif = flags.includes("--gif");
const allFrames = flags.includes("--all-frames");

async function findChrome() {
  const root = join(homedir(), ".cache", "ms-playwright");
  const dirs = (await readdir(root)).filter(d => d.startsWith("chromium_headless_shell-")).sort();
  const latest = dirs.at(-1);
  if (!latest) throw new Error("No chromium_headless_shell in ~/.cache/ms-playwright");
  return join(root, latest, "chrome-headless-shell-linux64", "chrome-headless-shell");
}

const xterm = resolve(import.meta.dir, "..", "node_modules", "@xterm");
const background = "#101820";
const sgr = (c: { rgba: number[] }, base: 38 | 48) => ((c.rgba[3] ?? 255) === 0 ? `${base + 1}` : `${base};2;${c.rgba[0]};${c.rgba[1]};${c.rgba[2]}`);
const sgrFlags = [[attributes.BOLD, "1"], [attributes.DIM, "2"], [attributes.ITALIC, "3"], [attributes.UNDERLINE, "4"],
  [attributes.INVERSE, "7"], [attributes.HIDDEN, "8"], [attributes.STRIKETHROUGH, "9"]] as const;

// Replay the frame as ANSI so xterm.js lays out cells and draws box glyphs edge to edge, like a real terminal.
function frameAnsi(frame: Frame) {
  return "\x1b[?25l" + frame.screen.lines.map((line, row) => `\x1b[${row + 1};1H` + line.map(run => {
    const codes = ["0", sgr(run.fg, 38), sgr(run.bg, 48), ...sgrFlags.filter(([bit]) => run.attributes & bit).map(([, code]) => code)];
    return `\x1b[${codes.join(";")}m${run.text}`;
  }).join("")).join("") + "\x1b[0m";
}

function frameHtml(frame: Frame) {
  const { cols, rows } = frame.screen;
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${xterm}/xterm/css/xterm.css">
<script src="file://${xterm}/xterm/lib/xterm.js"></script><script src="file://${xterm}/addon-webgl/lib/addon-webgl.js"></script>
<style>html,body{margin:0;background:${background}}#terminal{padding:8px}</style></head><body><div id="terminal"></div><script>
const term = new Terminal({ cols: ${cols}, rows: ${rows}, fontFamily: '"DejaVu Sans Mono", monospace', fontSize: 16, lineHeight: 1,
  customGlyphs: true, drawBoldTextInBrightColors: false, cursorInactiveStyle: "none", theme: { background: "${background}" } });
term.open(document.getElementById("terminal"));
term.loadAddon(new WebglAddon.WebglAddon());
term.write(${JSON.stringify(frameAnsi(frame))});
</script></body></html>`;
}

async function screenshot(chrome: string, html: string, png: string, cols: number, rows: number) {
  const htmlPath = png.replace(/\.png$/, ".html");
  await Bun.write(htmlPath, html);
  // xterm.js cells for 16px DejaVu Sans Mono are 9.5px wide and 19px tall; add padding.
  const width = Math.ceil(cols * 9.5) + 16;
  const height = Math.ceil(rows * 19) + 16;
  const proc = Bun.spawn([chrome, "--headless", "--no-sandbox", "--hide-scrollbars", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--virtual-time-budget=2000", `--screenshot=${png}`, `--window-size=${width},${height}`, "--force-device-scale-factor=2", `file://${htmlPath}`], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  await rm(htmlPath);
  if (proc.exitCode !== 0) throw new Error(`chrome exited with ${proc.exitCode} for ${png}`);
}

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

const file = source.endsWith(".json") ? source : join(source, "recording.json");
const recordings = (await Bun.file(file).json()) as Recording[];
const chrome = await findChrome();
const outDir = resolve(output);
await mkdir(outDir, { recursive: true });

for (const recording of recordings) {
  const prefix = recordings.length > 1 ? `${slug(recording.title)}-` : "";
  const frames = recording.frames;
  if (!frames.length) continue;
  const frameAt = (at: number) => frames.reduce((best, f) => (f.at <= at ? f : best), frames[0]!);
  let n = 0;
  for (const event of recording.events) {
    const frame = frameAt(event.at);
    const png = join(outDir, `${prefix}${String(++n).padStart(2, "0")}-${slug(event.label)}.png`);
    await screenshot(chrome, frameHtml(frame), png, frame.screen.cols, frame.screen.rows);
    console.log(png);
  }
  const last = frames.at(-1)!;
  const finalPng = join(outDir, `${prefix}final.png`);
  await screenshot(chrome, frameHtml(last), finalPng, last.screen.cols, last.screen.rows);
  console.log(finalPng);

  if (makeGif || allFrames) {
    const seqDir = join(outDir, `${prefix}frames`);
    await mkdir(seqDir, { recursive: true });
    const concat: string[] = [];
    for (const [i, frame] of frames.entries()) {
      const png = join(seqDir, `${String(i).padStart(4, "0")}.png`);
      await screenshot(chrome, frameHtml(frame), png, frame.screen.cols, frame.screen.rows);
      const next = frames[i + 1];
      // Hold each frame for its real duration, clamped so scrubbing stays readable; hold the last frame 2s.
      const duration = Math.min(2.5, Math.max(0.15, ((next?.at ?? frame.at + 2000) - frame.at) / 1000));
      concat.push(`file '${png}'`, `duration ${duration}`);
    }
    concat.push(`file '${join(seqDir, `${String(frames.length - 1).padStart(4, "0")}.png`)}'`);
    const list = join(seqDir, "list.txt");
    await Bun.write(list, concat.join("\n") + "\n");
    if (makeGif) {
      const gif = join(outDir, `${prefix}recording.gif`);
      const ff = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
        "-vf", "scale=iw/2:ih/2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=none", "-loop", "0", gif]);
      await ff.exited;
      if (ff.exitCode !== 0) throw new Error("ffmpeg failed");
      console.log(gif);
    }
    if (!allFrames) await rm(seqDir, { recursive: true, force: true });
  }
}
