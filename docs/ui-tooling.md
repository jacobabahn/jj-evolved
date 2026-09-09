# Test and record terminal workflows

The UI tooling runs the real application with OpenTUI's headless renderer and a temporary jj repository. The same scenarios power the regression tests and a browser gallery. It uses the existing Bun, jj, and OpenTUI installation.

## Run the scenarios

```bash
bun run test:ui
bun run ui list
bun run ui gallery
bun run ui record rebase
```

`gallery` records every scenario and prints the path to `artifacts/ui/gallery/index.html`. Open that file in a browser. Select a scenario, move the frame slider, or press **Play**. Expand **Scenario actions** to jump to an input or a named checkpoint.

`record rebase` writes one scenario to `artifacts/ui/rebase/`. Each output directory contains a standalone `index.html` and `recording.json`. Copy the HTML file to share a replay; it needs no server or external assets. Repeat a command to replace its previous output. Supply a different directory to keep another run:

```bash
bun run ui record rebase artifacts/ui/rebase-before
bun run ui gallery artifacts/ui/gallery-after
```

The scenarios cover browsing, a diff, help at 80 columns, rebase review and cancellation, an empty revset, an editable bookmark error, bookmark dragging, live themes, and Unicode paste. They create and remove their own repositories. Theme scenarios use an in-memory save callback, so they do not change your saved theme.

## Add a scenario

Add an entry to [tooling/scenarios.ts](../tooling/scenarios.ts). It automatically appears in the gallery, CLI list, and scenario tests. Drive the app through input and verify the result with the real repository:

```typescript
{
	name: "describe",
	title: "Edit a description",
	async run(ui) {
		ui.key("d");
		await ui.until("Describe");
		await ui.prompt("Reviewed change");
		assert.equal((await ui.repo.snapshot("@")).revisions[0]?.description.trim(), "Reviewed change");
		await ui.capture("Saved description");
	},
}
```

`ui.until(text)` renders and waits with a three-second wall-clock deadline. This lets jj subprocesses finish even when the renderer has no pending frames. A single `renderOnce()` or `waitForVisualIdle()` does not prove that repository work has completed. Wait for the specific result before taking a checkpoint.

The shared fixture exposes these operations:

| Operation | Purpose |
| --- | --- |
| `key(name, modifiers?)` | Send a key through OpenTUI's input parser. Named keys include `RETURN`, `ESCAPE`, and `ARROW_DOWN`. |
| `type(text)`, `paste(text)` | Type text or send bracketed paste. Use paste for Unicode graphemes. |
| `prompt(text)` | Replace the focused prompt, submit, and wait for `Ready.` |
| `choose(name, id?)` | Navigate a focused selection menu by item name and press Enter. |
| `resize(width, height)` | Resize the renderer and render a frame. |
| `target(id)` | Save a renderable ID and its instance identity. |
| `click(target)`, `drag(from, to)`, `scroll(target, direction)` | Send mouse input using current element bounds. Accept IDs or saved targets. |
| `inspect()` | List visible renderable IDs, types, focus, and bounds. |
| `capture(label)` | Capture styled output and add a checkpoint to the recording. |
| `repo`, `f` | Inspect the repository, run jj commands, or create fixture files. |

Saved targets reject replaced renderables. Mouse actions also reject hidden, covered, or offscreen center points. The driver uses existing renderable IDs. Revision-row IDs are positional, so resolve them again from the current graph after a refresh. This is an in-process driver, not a remote control server.

## Keep failure evidence

Use `withUiFixture` for new renderer tests:

```typescript
import { test, expect } from "bun:test";
import { withUiFixture } from "../tooling/ui";

test("opens help", () => withUiFixture("opens-help", async ui => {
	ui.key("?");
	expect(await ui.until("Keyboard reference")).toContain("Keyboard reference");
}));
```

If the callback throws, the wrapper writes a unique directory under `artifacts/ui/failures/` and prints its HTML path. The replay includes the original error, changed frames, and driver actions. The wrapper then rethrows the error and cleans up the renderer and repository. Setup failures and test-runner termination before the callback can unwind do not produce a replay.

Existing tests that construct their own renderer do not automatically gain failure recording. The new scenario and snapshot suite uses the wrapper. For manual ownership, `createUiFixture()` supports both `cleanup()` and `await using`.

## Review snapshots

[tests/ui-tooling.test.ts](../tests/ui-tooling.test.ts) checks actual selected-text colors, footer styles, and help layout at 80 and 120 columns. It snapshots stable content instead of masking random IDs throughout the screen. Review [the snapshot file](../tests/__snapshots__/ui-tooling.test.ts.snap) after an intentional visual change:

```bash
bun test tests/ui-tooling.test.ts --update-snapshots
git diff -- tests/__snapshots__/ui-tooling.test.ts.snap
bun run test:ui
```

The suite also exercises Kitty input, stable-target validation, recording retention, failure artifacts, cleanup, and safe HTML embedding. The full `bun test` command includes this suite.

## Recording format and limits

The recorder listens to completed renderer frames, following OpenTUI's TestRecorder approach, and serializes public `captureSpans()` output. Each changed frame stores elapsed milliseconds, dimensions, cursor coordinates, and text runs with widths, color values, color intent, and attributes. The recorder keeps the last 240 changed frames and up to 1,000 action labels. The viewer reports dropped frames.

These are styled screen recordings with browser playback, not native terminal captures or MP4/GIF files. The viewer preserves cell widths and common text attributes, but does not animate blinking or draw the recorded cursor. Browser fonts, Unicode shaping, and terminal-default color resolution can differ from a real terminal. Dark is the gallery's fixed starting theme; the JSON also preserves indexed/default color intent.

Recordings retain fixture paths, generated IDs, and real timing. They are debugging artifacts rather than byte-stable snapshots. Generated output is ignored by Git. No OpenCode backend, Solid renderer, WebSocket server, or new dependency is required.

See [the upstream research](opencode-v2-tooling-research.md) for the OpenCode simulation, semantic-target, storybook, and recording designs that informed this tooling.
