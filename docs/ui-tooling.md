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

Scenarios record at 100×30 by default. Pass `--size <cols>x<rows>` to record in a larger or smaller terminal:

```bash
bun run ui record readme --size 120x35
```

## Render screenshots

`tooling/render.ts` turns a recording into PNG screenshots, one per checkpoint plus `final.png`. Add `--gif` for an animated GIF, which needs ffmpeg:

```bash
bun tooling/render.ts artifacts/ui/readme artifacts/ui/readme-png
```

Frames are drawn by xterm.js with its WebGL renderer in the Playwright headless Chrome from `~/.cache/ms-playwright`. xterm.js draws box-drawing characters itself, so borders and graph lines join like they do in Ghostty or another GPU terminal. The `readme` scenario produces the README's rebase preview image, `docs/images/rebase-preview.png`, from its `rebase-preview` checkpoint.

The eight scenarios cover browsing, a diff, help at 80 columns, rebase review and cancellation, an empty revset, an editable bookmark error, bookmark dragging, live themes, Unicode paste, stale-review recovery, and late diff responses. They create and remove their own repositories. Theme scenarios use an in-memory save callback, so they do not change your saved theme.

## Verify review and preview lifetimes

`bun run ui record review-retry` records an editable rebase form rejecting a stale preview after an external jj operation. It then refreshes the review, applies the rebase, and checks the actual parent relationship and closed form.

`bun run ui record preview-race` delays a real diff while the user selects another revision. It records both late success and late failure, checking that neither replaces the newer preview. The scenario restores the original diff method after each controlled delay.

Both scenarios run automatically in `bun run test:ui` and appear in `bun run ui gallery`.

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

Recordings retain fixture paths, generated IDs, and real timing. They are debugging artifacts rather than byte-stable snapshots. Generated output is ignored by Git. No OpenCode backend, Solid renderer, or WebSocket server is required. Only the screenshot renderer uses the `@xterm/xterm` and `@xterm/addon-webgl` dev dependencies.

See [the upstream research](opencode-v2-tooling-research.md) for the OpenCode simulation, semantic-target, storybook, and recording designs that informed this tooling.

## Compare performance in a real terminal

The headless scenarios above check behavior. `bun run compare` checks responsiveness. It runs two builds of the app in a real terminal (tmux), replays the same scripted keystrokes against a generated history, and reports how quickly each build keeps up and how many `jj` processes it starts:

```bash
bun run compare list
bun run compare selection                                   # origin/main vs. your working tree
bun run compare diff-preview --before main --after my-branch
bun run compare idle-refresh --no-gif                       # metrics only
```

`--before` defaults to `origin/main` (or `main`), and `--after` defaults to `.`, the current working tree including uncommitted edits. Any other ref is checked out into a temporary worktree with `bun install --frozen-lockfile` and removed afterwards. Output goes to `artifacts/compare/<scenario>/` (override it with `--out`):

| File | Contents |
| --- | --- |
| `summary.md` | Before/after metric table, ready to paste into a pull request |
| `metrics.json` | The same numbers, plus the scenario and history size |
| `compare.gif` | Before stacked above after, both driven by identical keystrokes |
| `before.gif`, `after.gif`, `*.cast` | Each side on its own, and the asciinema recordings |

Each recording shows the app beside a sidebar that counts keys sent and every `jj` process the app starts, with the most recent commands. A PATH shim logs each `jj` call and then runs the real `jj`. The status bar labels each side with its ref and commit.

### Metrics

- **Startup until "Ready"**: time from launch until the app shows `Ready`.
- **Catch-up after a burst**: time from the last key of a burst until the app pane stays unchanged for 300 ms. This shows input lag: a build that falls behind keeps redrawing after the keys stop. The pane is sampled every ~10 ms with `tmux capture-pane`.
- **jj processes**: the total, per subcommand (`diff`, `log`, `op log`, `status`, …), per burst (from its first key until the next burst starts), and while idle before the first key.
- **Screen states showing "…"**: for scenarios that list `watch` text, how many distinct screen states contained it, such as the `Loading diff` placeholder.

Timings vary by a few milliseconds between runs and machines; compare both sides of one run rather than numbers across runs. Process counts and screen-state counts are more stable.

### Reproducibility

Both sides use the same generated history: a linear chain of `--commits` changes (default 400), cached at `$TMPDIR/jj-evolved-compare-history-<N>` and copied fresh for each side. The app runs on a private tmux server started with `-f /dev/null`, with a temporary `JJ_CONFIG` and `XDG_CONFIG_HOME`, so your jj settings, saved theme and keybindings don't affect the result. The window is 150×40 with a fixed theme (`--theme`, default `tokyonight`). Scenario keys use tmux `send-keys` names and target the default `jjui` key preset. Comparing against refs from before that preset existed may need different keys.

### Requirements

`git`, `jj` and `tmux` are always required. GIFs also need [asciinema](https://asciinema.org/) (`uv tool install asciinema`), [agg](https://github.com/asciinema/agg/releases) on `PATH` or at `$AGG`, and `ffmpeg`. Missing tools are listed with install hints, and `--no-gif` skips recording. Verified on Linux with tmux 3.6, asciinema 2.4 and agg 1.9. asciinema 3 is detected and asked for v2-format casts, but hasn't been tested. The PATH shim uses Bash's `EPOCHREALTIME` for sub-millisecond timestamps.

### Add a terminal scenario

Add an entry to [tooling/terminal-scenarios.ts](../tooling/terminal-scenarios.ts). Steps either send a labelled burst of keys at a fixed interval or wait:

```typescript
{
	name: "search",
	title: "Type a search query",
	watch: ["Searching"],
	steps: [
		{ keys: ["/"], interval: 0, label: "open search" }, { wait: 500 },
		{ keys: [..."change 12"], interval: 40, label: "type query" }, { wait: 2000 },
	],
}
```

Leave enough waiting after each burst for the slower side to settle, because catch-up is measured only until the next burst starts. [tests/terminal-compare.test.ts](../tests/terminal-compare.test.ts) covers the metric calculations; the recorder itself needs tmux and isn't part of `bun test`.

### Use the output in a pull request

Paste `summary.md` into the description and replace the image link with a hosted copy of `compare.gif`. GitHub hosts the file if you drag it into the PR editor. From the command line, you can instead push it to a separate branch and link to it:

```text
https://github.com/<owner>/<repo>/blob/<branch>/<path>.gif?raw=true
```
