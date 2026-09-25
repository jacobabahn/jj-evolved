import type { Keybindings } from "../src/ui/keybindings";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { SelectRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, type MockInput } from "@opentui/core/testing";
import { createApp } from "../src/app";
import { Repository } from "../src/repository/repository";
import { themes, type ThemeName } from "../src/ui/theme";
import { fixture } from "../tests/fixture";
import { recordScreen, styledFrame, writeRecording } from "./recording";

type Target = { id: string; instance: number };
type FixtureOptions = {
  bindings?: Keybindings;
  width?: number;
  height?: number;
  theme?: ThemeName;
  kittyKeyboard?: boolean;
  timeoutMs?: number;
  prepare?: (repository: Awaited<ReturnType<typeof fixture>>) => Promise<void>;
};

export async function createUiFixture(options: FixtureOptions = {}) {
  const f = await fixture();
  try {
    await options.prepare?.(f);
    const screen = await createTestRenderer({
      width: options.width ?? 100, height: options.height ?? 30,
      kittyKeyboard: options.kittyKeyboard ?? false, useThread: false,
    });
    const recording = recordScreen(screen);
    let app: ReturnType<typeof createApp> | undefined;
    try {
      const repo = await Repository.open(f.path);
      app = createApp(screen.renderer, repo, themes[options.theme ?? "terminal"], undefined, options.bindings);
      await app.start();
      await screen.renderOnce();
      let disposed = false;

      function node(target: string | Target): Renderable {
        const id = typeof target === "string" ? target : target.id;
        const value = screen.renderer.root.findDescendantById(id);
        if (!value || value.isDestroyed) throw new Error(`Missing UI target: ${id}`);
        if (typeof target !== "string" && target.instance !== value.num) throw new Error(`Stale UI target: ${id}`);
        for (let parent: Renderable | null = value; parent; parent = parent.parent) {
          if (!parent.visible) throw new Error(`Hidden UI target: ${id}`);
        }
        return value;
      }

      function point(target: string | Target) {
        const value = node(target);
        const x = Math.floor(value.screenX + value.width / 2);
        const y = Math.floor(value.screenY + value.height / 2);
        const hit = screen.renderer.hitTest(x, y);
        function contains(item: Renderable): boolean {
          return item.num === hit || item.getChildren().some(contains);
        }
        if (value.width <= 0 || value.height <= 0 || x < 0 || y < 0 || x >= screen.renderer.width || y >= screen.renderer.height || !contains(value)) {
          throw new Error(`UI target is clipped or covered: ${value.id}`);
        }
        return { x, y };
      }

      function key(...args: Parameters<MockInput["pressKey"]>) {
        recording.mark(`key ${args[0]}${args[1] ? ` ${JSON.stringify(args[1])}` : ""}`);
        screen.mockInput.pressKey(...args);
      }

      async function until(text: string) {
        const deadline = performance.now() + (options.timeoutMs ?? 3000);
        do {
          await screen.renderOnce();
          const frame = screen.captureCharFrame();
          if (frame.includes(text)) return frame;
          await Bun.sleep(10);
        } while (performance.now() < deadline);
        throw new Error(`Expected screen to contain ${JSON.stringify(text)}:\n${screen.captureCharFrame()}`);
      }

      function choose(name: string, id = "action-choices") {
        const chooser = node(id);
        if (!(chooser instanceof SelectRenderable)) throw new Error(`UI target is not a selection menu: ${id}`);
        if (!chooser.focused) throw new Error(`UI menu does not have keyboard focus: ${id}`);
        const destination = chooser.options.findIndex(option => option.name === name);
        if (destination < 0) throw new Error(`Missing choice: ${name}`);
        recording.mark(`choose ${name} in ${id}`);
        for (let index = 0; index < chooser.options.length; index++) {
          if (chooser.getSelectedOption()?.name === name) { screen.mockInput.pressEnter(); return; }
          screen.mockInput.pressKey(chooser.getSelectedIndex() < destination ? "j" : "k");
        }
        throw new Error(`Could not reach choice: ${name}`);
      }

      async function cleanup() {
        if (disposed) return;
        disposed = true;
        recording.stop();
        try { app?.stop(); } finally {
          try { screen.renderer.destroy(); } finally { await f.cleanup(); }
        }
      }

      return {
        f, screen, repo, app, recording, key, until, choose, node, cleanup,
        [Symbol.asyncDispose]: cleanup,
        target(id: string): Target { return { id, instance: node(id).num }; },
        async type(text: string) { recording.mark(`type ${text}`); await screen.mockInput.typeText(text); },
        async paste(text: string) { recording.mark(`paste ${text}`); await screen.mockInput.pasteBracketedText(text); },
        async prompt(value: string) {
          recording.mark(`replace prompt with ${value} and submit`);
          key("a", { ctrl: true }); key("k", { ctrl: true });
          await screen.mockInput.typeText(value);
          if (screen.renderer.root.findDescendantById("description-input")?.visible) key("s", { ctrl: true }); else screen.mockInput.pressEnter();
          await until("Ready.");
        },
        async resize(width: number, height: number) {
          recording.mark(`resize ${width}x${height}`);
          screen.resize(width, height);
          await screen.renderOnce();
        },
        async click(target: string | Target) {
          const { x, y } = point(target);
          recording.mark(`click ${typeof target === "string" ? target : target.id}`);
          await screen.mockMouse.click(x, y);
          await screen.renderOnce();
        },
        async drag(from: string | Target, to: string | Target) {
          const start = point(from), end = point(to);
          recording.mark(`drag ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
          await screen.mockMouse.drag(start.x, start.y, end.x, end.y);
          await screen.renderOnce();
        },
        async scroll(target: string | Target, direction: "up" | "down" | "left" | "right") {
          const { x, y } = point(target);
          recording.mark(`scroll ${typeof target === "string" ? target : target.id} ${direction}`);
          await screen.mockMouse.scroll(x, y, direction);
          await screen.renderOnce();
        },
        async capture(label: string) {
          await screen.renderOnce();
          recording.mark(label, true);
          return styledFrame(screen.captureSpans());
        },
        inspect() {
          const elements: { id: string; type: string; focused: boolean; x: number; y: number; width: number; height: number }[] = [];
          function visit(value: Renderable) {
            if (!value.visible) return;
            elements.push({ id: value.id, type: value.constructor.name, focused: value.focused, x: value.screenX, y: value.screenY, width: value.width, height: value.height });
            value.getChildren().forEach(visit);
          }
          visit(screen.renderer.root);
          return elements;
        },
      };
    } catch (error) {
      recording.stop();
      try { app?.stop(); } finally { screen.renderer.destroy(); }
      throw error;
    }
  } catch (error) { await f.cleanup(); throw error; }
}

export type UiFixture = Awaited<ReturnType<typeof createUiFixture>>;

export async function withUiFixture<T>(name: string, run: (ui: UiFixture) => Promise<T>, options: FixtureOptions & { artifactRoot?: string } = {}) {
  const ui = await createUiFixture(options);
  try {
    return await run(ui);
  } catch (error) {
    try {
      const root = resolve(options.artifactRoot ?? "artifacts/ui/failures");
      await mkdir(root, { recursive: true });
      const directory = await mkdtemp(join(root, `${name.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 70)}-`));
      const path = await writeRecording(directory, [ui.recording.snapshot(name, error)]);
      process.stderr.write(`UI failure recording: ${path}\n`);
    } catch (artifactError) {
      process.stderr.write(`Could not save UI failure recording: ${String(artifactError)}\n`);
    }
    throw error;
  } finally { await ui.cleanup(); }
}
