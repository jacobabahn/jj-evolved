# OpenCode v2 terminal UI tooling

Research target: [`anomalyco/opencode` branch `v2` at `148042ab814a936572e856c34a0ba05dbd6798f3`](https://github.com/anomalyco/opencode/tree/148042ab814a936572e856c34a0ba05dbd6798f3). This note covers the terminal UI. OpenCode's separate browser and desktop app tests are called out where they might otherwise look like TUI coverage.

## What is worth bringing over

### 1. A full application fixture around OpenTUI's test renderer

OpenCode's most directly reusable testing idea is [`createAppFixture`](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/tui/test/fixture/app.ts). It creates an OpenTUI test renderer with a fixed viewport, `useThread: false`, and Kitty keyboard input, starts the real TUI application, and connects it to an in-process Bun HTTP server. Tests can supply a fetch handler and push events through a controlled event stream. The fixture also owns cleanup through `Symbol.asyncDispose`.

Tests then exercise the screen as a user would. For example, the [session wheel and focus test](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/tui/test/session-wheel-focus.test.tsx) types commands, presses keys, scrolls, clicks, drags a resize handle, waits for rendered content, and inspects renderable coordinates. The [session tabs tests](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/tui/test/component/session-tabs-status.test.tsx) check character frames and styled spans, including text attributes, across multiple viewport sizes. Other component tests use OpenTUI's [`ManualClock`](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/tui/test/component/retry-provider.test.tsx) to make time-based rendering deterministic.

For jj-evolved, the useful next step is to deepen the existing renderer tests into a shared full-app harness with:

- real temporary jj repositories for normal operation tests;
- controlled repository responses for races, errors, and long-running operations;
- keyboard, mouse, drag, scroll, and resize workflows;
- character-frame assertions for content and `captureSpans()` assertions for color or emphasis;
- deterministic clocks for animation and delayed UI state;
- one owner for renderer, temporary repository, and process cleanup.

This is a small extension of tooling already present here. It does not require OpenCode's simulation stack.

### 2. A renderer-neutral control API

OpenCode v2 also contains a larger [`@opencode/simulation` package](https://github.com/anomalyco/opencode/tree/148042ab814a936572e856c34a0ba05dbd6798f3/packages/simulation). The TUI selects it when `OPENCODE_DRIVE` is set. It can run against a visible CLI renderer or a headless [`createTestRenderer`](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/simulation/src/frontend/renderer.ts), then exposes a loopback WebSocket JSON-RPC server.

The [action harness](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/simulation/src/frontend/actions.ts) supports text input, named keys, arrows, focus, mouse movement and buttons, scrolling, element-relative clicks, viewport resize, screen-text matching, and one-shot rendering. `ui.capture` returns a normalized frame made of lines and spans with text, foreground, background, attributes, and display width. `ui.state` reports focusable and clickable renderables plus bounds. This makes the same scenario usable for fast headless checks and a visible debugging run.

The best adaptation here would be a thin in-process driver over the existing test renderer. A WebSocket protocol only pays off if an external scenario runner or another process must drive jj-evolved. OpenCode's package is not a good direct transplant: its dependencies include several OpenCode packages, Effect services, its protocol package, and its simulated backend/provider.

Its visible-renderer fallback is also version-sensitive. The harness reads OpenTUI's private `currentRenderBuffer` and uses reflection to discover mouse listeners. The headless path uses supported test-renderer methods. A local driver should prefer those public methods and isolate any private access behind one adapter with a pinned OpenTUI version.

### 3. Semantic targets instead of screen coordinates

OpenCode layers stable meaning onto OpenTUI renderables. Components opt in with [`SimulationSemantics.bind`](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/tui/src/simulation/semantics.ts). The simulation walker produces an [`opencode-ui-snapshot-v1`](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/simulation/src/frontend/actions.ts) tree containing stable IDs, parent relationships, roles, labels, values, instance identity, and the current renderable handle. Semantic clicks verify that the target still has the expected identity before dispatching input.

This is valuable for jj-evolved once coordinate-driven tests become fragile. Add semantic IDs only to important controls such as change rows, action buttons, dialogs, and revision selectors. A small `findBySemanticId()` helper would give tests stable targets while preserving frame assertions for actual layout.

### 4. Recordings that preserve terminal output and input timing

The current v2 branch records a terminal session through [`Timeline`](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/simulation/src/recording.ts). It writes a versioned JSONL stream with initial columns and rows, timestamped base64 ANSI output, and timestamped resize events. Mouse activity goes into a synchronized `*.pointers.jsonl` sidecar. The simulation renderer redirects OpenTUI's buffered output into that stream, so a recording captures what a terminal receives rather than a list of logical UI states.

The checked-in [`shell-output` Drive scenario](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/script/drive/shell-output.ts) shows the intended workflow. It builds a temporary Git project, scripts model output, runs a real shell command, drives the TUI, adds named recording marks, captures stills, changes the viewport from 90x30 to 40x24 and back, and finishes the recording. This is a useful shape for before-and-after demos and regression artifacts.

There is an important boundary. The branch does not vendor the `opencode-drive` runner used by that script, and the current simulation package returns normalized frames or the ANSI timeline path. The `ui.screenshot`, recording marks, and final playable artifact in the example belong to the external runner. A jj-evolved port should first record the existing OpenTUI output stream and input/resize events. Rendering that timeline to a GIF, MP4, or web player is a separate tool.

### 5. An in-app component gallery

The built-in [TUI Storybook](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/tui/src/feature-plugins/system/storybook/index.tsx) registers command-palette entries for full-screen, fixture-driven views of production components. Current stories cover responsive diagrams, session tabs, a missing-directory recovery state, and spinner designs. Each owns the whole terminal and provides keyboard navigation back to the index.

This is manual visual tooling, not an automated snapshot suite. A small jj-evolved gallery would still be useful for dense tree states, empty and error states, narrow terminals, long paths, Unicode content, and overlays. Because it renders real components with fixed data, the same fixtures could later feed headless frame tests and recording scripts.

## Browser app tooling is separate

`packages/app/e2e` tests the browser and desktop UI with Playwright. It saves diagnostic PNGs in several regressions and has an opt-in [visual stability sampler](https://github.com/anomalyco/opencode/blob/148042ab814a936572e856c34a0ba05dbd6798f3/packages/app/e2e/utils/visual-stability/capture.ts) that asks Chrome DevTools for JPEG frames every 50 ms, up to 900 frames. Those techniques target DOM, Chromium, and Electron behavior. They do not exercise the OpenTUI terminal renderer and should not be counted as TUI screenshot or recording coverage.

## Suggested adoption order

1. Add focused character and styled-span snapshots to the existing real-jj renderer tests. Use the installed TestRecorder to inspect intermediate frames and retain failure artifacts.
2. Reuse the current app test setup as a shared fixture with a small input, resize, and capture driver. Add semantic lookup where existing renderable IDs are insufficient.
3. Add a fixture gallery for hard-to-reach visual states, then reuse those fixtures in tests and recordings.
4. Record a deterministic demo scenario, choosing ANSI recording for terminal replay or TestRecorder for headless regression evidence. Keep conversion or playback outside the application.
5. Consider a socket-based driver when an agent or external runner needs to inspect and control the live app.

## Limits of this review

The findings are pinned to the v2 commit above. `opencode-drive` is referenced by the repository but its implementation is not present in this branch, so its screenshot renderer and playable recording format were not audited here. No claim in this note treats the Playwright browser suite as terminal UI coverage.

OpenCode's root license and `@opencode/simulation` package are MIT licensed. Copying implementation code rather than recreating the pattern requires retaining the license and copyright notice.

## OpenTUI tools already available here

Inspected OpenTUI at [6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e](https://github.com/anomalyco/opentui/tree/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e). jj-evolved has `@opentui/core` 0.5.11 installed.

The existing [app tests](../tests/app.test.ts) drive keyboard flows against a native in-memory renderer and real temporary jj repositories. They already check resizing and some element coordinates. [scripts/check-ui.ts](../scripts/check-ui.ts), present as an untracked file during this review, also dumps the screen and render tree. The next useful step is richer output assertions and reproducible artifacts.

- `captureSpans()` captures foreground, background, attributes, cursor, and screen dimensions. Add targeted snapshots for selected revisions, added and removed diff lines, modal focus, and the Before/After layout. Normalize temporary paths and generated revision IDs before whole-screen snapshots.
- `TestRecorder` captures each completed render pass, with elapsed timestamps and optional foreground, background, and attribute buffers. Test invariants across frames to catch disappearing rows or briefly incorrect selections. Its output is frame data, not an MP4 or GIF.
- `mockMouse`, bracketed paste, Kitty keyboard options, and terminal-capability fixtures extend input coverage without adding dependencies. Useful cases here include Unicode descriptions, escape cancellation, scroll boundaries, and focus after closing overlays.
- `ManualClock` controls renderer timers. It does not automatically control jj subprocesses or the app's global `setTimeout` success-message timer.
- `waitForFrame()` and `waitForVisualIdle()` help synchronize rendered UI. They use scheduler/frame bounds and can stop when the renderer is idle. Keep a separate bounded wait for external jj work; replacing every existing polling loop with these helpers would be incorrect.

Sources: [OpenTUI testing reference](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/web/src/content/docs/core-concepts/testing.mdx), [recorder implementation](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/core/src/testing/test-recorder.ts), and [scrollbox regression that checks recorded frames](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/core/src/tests/scrollbox-culling-bug.test.ts). API availability was also checked in the installed package's declarations and implementation.

A local proof exercised this app with the installed dependency. It started a temporary jj repository, recorded startup and keyboard help, resized to 80×24, and captured styled spans. The run produced seven frames with foreground, background, and attribute buffers. Rerun the session-local proof with `bun /tmp/jj-evolved-tui-recording-probe.ts`; it writes `/tmp/jj-evolved-tui-recording-probe.json`. These temporary files are not a permanent repository test. This verifies headless recording and capture, not terminal video export or OpenCode's simulation integration.

## Shareable recordings from OpenTUI's website tooling

OpenTUI's website has a separate pipeline:

```text
asciinema .cast → xterm headless replay → styled story JSON → browser player
```

The record wrapper supports a fixed terminal size and chapter markers. The documented workflow uses tmux to send setup keys and inspect the terminal. The builder samples screen states, retains changed frames, and supports chapter captions and timing. The browser player can retain recorded colors and backgrounds.

For jj-evolved, adapt this around `bun run demo` to record browsing, rebase preview, cancellation, and undo. Start with the cast and a standard player. Bring over the custom story builder and its Astro player only if a documentation site needs chapters and styled playback. The custom JSON format is not automatically compatible with OpenCode's simulation recording format, and neither workflow inspected here proves a ready-to-use MP4/GIF exporter.

Sources: [recording workflow](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/web/public/recordings/README.md), [record wrapper](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/web/scripts/recordings/bin/record), [cast replay](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/web/scripts/recordings/lib/replay.mjs).

## Other tools worth considering

OpenTUI exposes a native statistics overlay, render timing and cell-update counters, input diagnostics, and buffer dumps. These would help investigate large revision graphs or long diff scrolling before introducing a benchmark suite. See [rendering diagnostics](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/web/src/content/docs/test-and-debug/rendering-diagnostics.mdx).

`@opentui/keymap` supports focus-scoped command layers, binding diagnostics, help-text formatting, and standalone dispatch tests. Its plain OpenTUI adapter does not require adopting Solid. This becomes useful if the growing keyboard handler needs customizable bindings or stronger modal-routing guarantees. It is an additional dependency, so prioritize the existing Core testing APIs first. See [keymap README](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/keymap/README.md) and [package exports](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/keymap/package.json).
