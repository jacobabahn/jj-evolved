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

## Keyboard controls

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Move through revisions |
| Tab | Switch focus between revisions and preview |
| Page Up / Page Down | Scroll preview |
| `/` | Enter a revset; empty restores `all()` |
| `s` | Show working-copy status |
| `r` | Refresh repository data |
| `d` | Edit the selected revision's single-line description |
| `e` | Switch the working copy to the selected revision immediately |
| `n` | Confirm creation of a child of the selected revision |
| `R` / `S` | Start inline rebase / squash; choose a destination in the graph and Enter previews |
| Space | Open revision actions: edit, describe, rebase, squash, split, bookmark creation, abandon |
| `b` | Browse bookmarks; move, rename, or delete a local bookmark |
| `o` | Browse operation history, inspect an operation, or restore its state |
| `u` | Preview undo of the latest operation |
| `f` | Browse the selected revision's changed files |
| Enter | Return to the revision preview |
| `?` | Show help |
| Escape | Cancel a prompt |
| `q`, Ctrl-C | Quit |

Menu actions open in overlays, leaving the graph and selected revision visible behind them. Quick text edits use a smaller dialog. Use `j` and `k` to choose an item and Enter to select it. Page Up and Page Down scroll the overlay preview, and Escape cancels.

For inline rebase or squash, press `R` or `S` on the source, then use `j`/`k` or arrows to choose a destination. Enter opens a preview; Enter again applies. Escape returns from the preview to destination selection, or cancels from the graph. The source stays marked with `●`. Tab toggles rebase between the selected change and its descendants. Inline squash moves all files and keeps the destination description. Errors keep the mode active so you can adjust the destination or scope.

Rebase and squash previews show the proposed tree on the left and the current tree on the right with native graph lines, local bookmarks, and conflict markers. Both columns scroll together; long labels are clipped to preserve tree alignment. The view includes relevant descendants and parents, up to 40 revisions. Previewing does not change the working copy or live operation log.

The rebase and squash menu forms show the source, destination, options, and preview in one form. Enter edits the selected field. Choose **Apply** after reviewing the preview. You can change a field without restarting the action. Press `p` to refresh a stale preview.

For individual files or hunks, open the Space menu and choose **Squash interactively** or **Split interactively**. Squash asks you to choose a destination change first. The app pauses while JJ opens your configured diff editor, followed by your description editor when needed. Save and close the editor to let JJ apply your selection. Cancel using the editor's controls or Ctrl-C. The app resumes and refreshes the graph when JJ exits.

To review a change in [Hunk](https://github.com/modem-dev/hunk/), install its CLI with `npm install -g hunkdiff`, then select the change and choose **Open in Hunk** from the Space menu. The app runs `hunk show` with the selected commit in the repository directory. Close Hunk to return to the app and refresh the graph. Hunk is optional and must be on your PATH.

Errors stay inside the overlay and preserve your input. Success closes it, selects the resulting revision when available, and briefly shows a confirmation above the graph. The footer contains keyboard hints. If another command or working-copy edit changes the repository before confirmation, the app rejects the stale action.

Rebase can move one change or its descendants. Squash accepts all files or a selected group and lets you keep or replace the destination description. In its description field, Ctrl-D restores the choice to keep the destination text. Split selects whole files for the first change and preserves the original description on the second change. Enter toggles files in the file-selection menu; select **Continue** when the group is ready.

Drag a local `[bookmark]` label in the log onto another change to preview a move. The destination highlights while dragging. Release to open the confirmation, then press Enter to apply. Escape, dropping outside a change, or dropping on the source cancels. Each bookmark has its own label, so you can move one when several share a change. Bookmark entries with a remote name are read-only. Undo applies the inverse of the exact latest operation shown in its preview. Restore returns repository state and local bookmarks to a selected operation. Both preserve remote-tracking state and run without network operations.

The revision list and destination pickers show at most 200 revisions. Operation history starts with 50 entries and offers **Load older operations**. Refresh manually after commands in another terminal. Existing multiline descriptions can be preserved during squash but require the jj CLI for editing.

The log uses jj's native ancestry lines and node symbols. Editing both split descriptions in one flow remains to be implemented. Remote operations and hunk-level editing remain outside the MVP.

## Verify

```bash
bun run typecheck
bun test
```

Tests require `jj` on PATH. They use temporary repositories and exercise real CLI operations and the OpenTUI renderer.

See the [feature specification](docs/features.md) for scope and acceptance criteria, and the [implementation record](docs/implementation.md) for the architecture decision.
