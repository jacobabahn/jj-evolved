# jj-evolved

A keyboard-driven terminal workspace for Jujutsu, built with Bun and OpenTUI. Browse a jj-style revision graph and changed files, edit history, manage local bookmarks, and inspect or restore repository operations.

## Run

Install [Bun](https://bun.sh/) 1.3 or later and [Jujutsu](https://docs.jj-vcs.dev/latest/install-and-setup/). The current build is tested with jj 0.45.1.

```bash
bun install
bun run demo
```

The demo creates a temporary repository with example changes and deletes it when you quit. Edits inside the demo are disposable.

To work in an existing jj repository:

```bash
bun start /path/to/your/jj-repository
```

With no path, the app opens the current directory. The source checkout is not automatically initialized as a jj repository. `bun dev /path/to/your/jj-repository` runs with source watching.

## Themes

Press `t` to open the theme picker. Use `j`/`k` or the arrow keys to preview each theme across the app. Enter saves your choice; Escape restores the previous theme.

Available themes are Terminal, Dark, Light, Gruvbox Dark, Tokyo Night, Catppuccin Mocha, and Vesper. The default Terminal theme inherits your terminal's foreground, background, and ANSI palette. It marks the selected revision with an arrow and diff additions and deletions with colored signs, preserving the terminal background.

Your selection is saved in `$XDG_CONFIG_HOME/jj-evolved/theme`, or `~/.config/jj-evolved/theme` when that variable is unset. It applies across repositories and to `bun run demo`.

You can also choose a theme at startup:

```bash
bun start --theme gruvbox /path/to/repository
bun start --theme tokyonight /path/to/repository
bun start --theme catppuccin /path/to/repository
bun start --theme vesper /path/to/repository
```

Startup precedence is `--theme`, then `JJ_EVOLVED_THEME`, then the saved choice, then `terminal`. The picker can change any startup choice for the current session. An explicit flag or environment variable still takes precedence on the next launch. Choose Terminal in the picker to save terminal colors as your preference.

The bundled palettes adapt [Gruvbox](https://github.com/morhetz/gruvbox), [Tokyo Night](https://github.com/folke/tokyonight.nvim), [Catppuccin Mocha](https://github.com/catppuccin/palette), and [Vesper](https://github.com/raunofreiberg/vesper) to the app's graph and diff colors.

## Keyboard controls

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Move through revisions |
| Tab | Switch focus between revisions and preview |
| Page Up / Page Down | Scroll preview |
| `/` | Enter a revset; empty restores `all()` |
| `Ctrl+F` | Search descriptions, bookmarks, and ID prefixes throughout the active revset |
| `Ctrl+N` / `Ctrl+P` | Next / previous accepted search match, wrapping at either end |
| `@` | Select the working copy without editing it |
| `[` / `]` | Jump to a parent / child; choose when there are several |
| `Ctrl+O` | Return to the original view after revealing a distant or filtered target |
| `Escape` | Cancel search editing, or clear an accepted search |
| `s` | Show working-copy status |
| `r` | Refresh repository data |
| `d` | Edit the selected revision's single-line description |
| `e` | Switch the working copy to the selected revision immediately |
| `n` | Confirm creation of a child of the selected revision |
| `R` / `S` | Start inline rebase / squash; choose a destination in the graph and Enter previews |
| `a` | Preview absorbing the selected change's edits into mutable ancestors |
| `v` | Browse the selected change's evolution and preview each version's rewrite diff |
| Space | Open revision actions: edit, describe, rebase, squash, split, bookmark creation, abandon |
| `b` | Browse bookmarks; move, rename, or delete a local bookmark |
| `o` | Browse operation history, inspect an operation, or restore its state |
| `u` | Preview undo of the latest operation |
| `f` | Browse the selected revision's changed files |
| Enter | Return to the revision preview |
| `t` | Preview and save a theme |
| `?` | Show help |
| Escape | Cancel a prompt |
| `q`, Ctrl-C | Quit |

Menu actions open in overlays, leaving the graph and selected revision visible behind them. Quick text edits use a smaller dialog. Use `j` and `k` to choose an item and Enter to select it. Page Up and Page Down scroll the overlay preview, and Escape cancels.

Press `a`, or choose **Absorb into ancestors** from the Space menu, to distribute fixes across a stack. JJ chooses the mutable ancestors that last changed the affected lines. The preview shows the actual proposed operation changes and the edits remaining in the source. Edits JJ cannot assign stay in the source. Enter applies the preview; Escape cancels; `p` refreshes a stale preview. An emptied source with no description is abandoned. The app keeps the source selected if it survives, otherwise selects the working copy.

Press `v`, or choose **Change evolution** from the Space menu, to browse previous versions of a change. Use `j` and `k` to select a version and Page Up or Page Down to scroll its patch. The patch shows what that version changed relative to its predecessors, including description edits. The earliest version shows its creation patch. **Load older versions** expands beyond the initial 50 entries. Browsing stays at the repository state captured when the view opened and does not snapshot pending edits or switch the working copy. Close the view and refresh with `r` to include newer work.

For inline rebase or squash, press `R` or `S` on the source, then use `j`/`k` or arrows to choose a destination. Enter opens a preview; Enter again applies. Escape returns from the preview to destination selection, or cancels from the graph. The source stays marked with `●`. Tab toggles rebase between the selected change and its descendants. With descendants enabled, every moving change is marked `●`, and the hint shows the total count and how many are outside the loaded graph. Turning the option off clears the descendant markers. Inline squash moves all files and keeps the destination description. Errors keep the mode active so you can adjust the destination or scope.

Rebase and squash previews show the proposed tree on the left and the current tree on the right with native graph lines, local bookmarks, and conflict markers. Both columns scroll together; long labels are clipped to preserve tree alignment. The view includes relevant descendants and parents, up to 40 revisions. Previewing does not change the working copy or live operation log.

The rebase and squash menu forms show the source, destination, options, and preview in one form. Enter edits the selected field. Choose **Apply** after reviewing the preview. You can change a field without restarting the action. Press `p` to refresh a stale preview. With descendant scope enabled, the rebase form shows the number of moving changes and their full list before you choose a destination. Rebase previews mark moving changes in both trees and include the full list below them, even when the graph limits omit some descendants.

For individual files or hunks, open the Space menu and choose **Squash interactively** or **Split interactively**. Squash asks you to choose a destination change first. The app pauses while JJ opens your configured diff editor, followed by your description editor when needed. Save and close the editor to let JJ apply your selection. Cancel using the editor's controls or Ctrl-C. The app resumes and refreshes the graph when JJ exits.

To review a change in [Hunk](https://github.com/modem-dev/hunk/), install its CLI with `npm install -g hunkdiff`, then select the change and choose **Open in Hunk** from the Space menu. The app runs `hunk show` with the selected commit in the repository directory. Close Hunk to return to the app and refresh the graph. Hunk is optional and must be on your PATH.

Errors stay inside the overlay and preserve your input. Success closes it, selects the resulting revision when available, and briefly shows a confirmation above the graph. The footer contains keyboard hints. If another command or working-copy edit changes the repository before confirmation, the app rejects the stale action.

Rebase can move one change or its descendants. Squash accepts all files or a selected group and lets you keep or replace the destination description. In its description field, Ctrl-D restores the choice to keep the destination text. Split selects whole files for the first change and preserves the original description on the second change. Enter toggles files in the file-selection menu; select **Continue** when the group is ready.

Drag a local `[bookmark]` label in the log onto another change to preview a move. The destination highlights while dragging. Release to open the confirmation, then press Enter to apply. Escape, dropping outside a change, or dropping on the source cancels. Each bookmark has its own label, so you can move one when several share a change. Bookmark entries with a remote name are read-only. Undo applies the inverse of the exact latest operation shown in its preview. Restore returns repository state and local bookmarks to a selected operation. Both preserve remote-tracking state and run without network operations.

The initial revision list and destination pickers show at most 200 revisions. Search covers the full active revset, including full multiline descriptions and local and remote bookmark names. Text matching ignores case; change and commit IDs match by prefix. Typing previews the first match. Enter keeps the query for next and previous navigation; Escape restores the previous search and selection. Clearing an accepted search keeps the selection and revset. Matching revisions have a `*` marker. Distant targets open a temporary view of up to 40 revisions, including immediate parents and children. A `+` marks context outside the active revset. `Ctrl+O` restores the original selection and scroll position, including after repeated jumps. Search and navigation leave repository state unchanged. Operation history starts with 50 entries and offers **Load older operations**. Refresh manually after commands in another terminal. Existing multiline descriptions can be preserved during squash but require the jj CLI for editing.

The log uses jj's native ancestry lines and node symbols. Editing both split descriptions in one flow remains to be implemented. Remote operations and an in-app hunk editor remain outside the MVP.

## Verify

```bash
bun run typecheck
bun run check:architecture
bun test
```

Tests require `jj` on PATH. They use temporary repositories and exercise real CLI operations and the OpenTUI renderer.

For styled snapshots, recorded UI scenarios, and a browsable gallery:

```bash
bun run test:ui
bun run ui gallery
bun run ui record rebase
```

Open the printed HTML path to inspect frames, play a recording, or switch scenarios. Scenario failures save a replay under `artifacts/ui/failures/`. See [the UI tooling guide](docs/ui-tooling.md) to add scenarios and update snapshots.

See the [feature specification](docs/features.md) for scope and acceptance criteria, and the [implementation record](docs/implementation.md) for the architecture decision.
