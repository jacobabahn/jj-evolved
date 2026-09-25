# Usage guide

Detailed controls and workflows for [jj-evolved](../README.md). Press `?` in the app for keyboard help.

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
| `p` | Hide/show preview; the graph expands when hidden |
| Page Up / Page Down | Scroll preview by page |
| `Ctrl+N` / `Ctrl+P` | Scroll preview by line without leaving the graph |
| `Ctrl+D` / `Ctrl+U` | Scroll preview by half page |
| `L` | Enter a revset; empty restores `all()` |
| `/` | Search descriptions, bookmarks, and ID prefixes throughout the active revset |
| `'` / `"` | Next / previous accepted search match, wrapping at either end |
| `@` | Select the working copy without editing it |
| `[` / `]` | Jump to a parent / child; choose when there are several |
| `Ctrl+O` | Return to the original view after revealing a distant or filtered target |
| `Escape` | Cancel search editing, or clear an accepted search |
| `w` | Show working-copy status |
| `Ctrl+R` | Refresh repository data |
| `Ctrl+L` | Load 200 more revisions |
| Enter | Edit a multiline description in the app |
| `D` | Edit the description in JJ's configured editor |
| `e` | Switch the working copy to the selected revision immediately; `u` previews an undo |
| `n` | Create an empty child of the selected revision immediately; `u` previews an undo |
| `r` / `S` | Start inline rebase / squash; choose a destination in the graph and Enter previews |
| Tab (during inline rebase) | Toggle whether descendants move with the change |
| `s` | Split selected files into a first change |
| `a` | Preview abandoning the selected change |
| `A` | Preview absorbing the selected change's edits into mutable ancestors |
| `v` | Browse the selected change's evolution and preview each version's rewrite diff |
| Space | Open revision actions: edit, describe, rebase, squash, split, bookmark creation, abandon |
| `b` | Browse bookmarks; move, rename, or delete a local bookmark |
| `g` | Git remotes: fetch, push, and select a remote |
| `o` | Browse operation history, inspect an operation, or restore its state |
| `u` | Preview undo of the latest operation |
| `l` / Right | Browse the selected revision's changed files; `h` / Left returns |
| `d` | Return to the revision's diff preview |
| `t` | Preview and save a theme |
| `?` | Show help |
| Escape | Cancel a prompt |
| `q`, Ctrl-C | Quit |

## Preview and overlays

Press `p` (the `togglePreview` binding) while browsing or choosing an inline rebase/squash destination to toggle the right-hand preview. While it is hidden, Tab keeps focus on the graph. `d`, `w`, or `?` reopens it for the revision preview, status, or help. The choice lasts for the current session.

Menu actions open in overlays, leaving the graph and selected revision visible behind them. Quick text edits use a smaller dialog. Use `j` and `k` to choose an item and Enter to select it. Page Up and Page Down scroll the overlay preview, and Escape cancels.

## Absorb

Press `A`, or choose **Absorb into ancestors** from the Space menu, to distribute fixes across a stack. JJ chooses the mutable ancestors that last changed the affected lines. The preview shows the actual proposed operation changes and the edits remaining in the source. Edits JJ cannot assign stay in the source. Enter applies the preview; Escape cancels; `p` refreshes a stale preview. An emptied source with no description is abandoned. The app keeps the source selected if it survives, otherwise selects the working copy.

## Change evolution

Press `v`, or choose **Change evolution** from the Space menu, to browse previous versions of a change. Use `j` and `k` to select a version and Page Up or Page Down to scroll its patch. The patch shows what that version changed relative to its predecessors, including description edits. The earliest version shows its creation patch. **Load older versions** expands beyond the initial 50 entries. Browsing stays at the repository state captured when the view opened and does not snapshot pending edits or switch the working copy. Close the view to resume automatic refresh; reopen it to include newer work.

## Rebase and squash

For inline rebase or squash, press `r` or `S` on the source, then use `j`/`k` or arrows to choose a destination. Enter opens a preview; Enter again applies. Escape returns from the preview to destination selection, or cancels from the graph. The source stays marked with `●`. For rebase, the hint shows a checkbox such as `[ ] include descendants (3 changes) · Tab toggle`; Tab (the `rebaseScope` binding) checks or clears it. With descendants included, every moving change is marked `●`, and the hint shows the total count and how many are outside the loaded graph. Turning the option off clears the descendant markers. Inline squash moves all files and keeps the destination description. Errors keep the mode active so you can adjust the destination or scope.

Rebase and squash previews show the proposed tree on the left and the current tree on the right with native graph lines, local bookmarks, and conflict markers. Both columns scroll together; long labels are clipped to preserve tree alignment. The view includes relevant descendants and parents, up to 40 revisions. Previewing does not change the working copy or live operation log.

The rebase and squash menu forms show the source, destination, options, and preview in one form. Enter edits the selected field. Choose **Apply** after reviewing the preview. You can change a field without restarting the action. Press `p` to refresh a stale preview. With descendant scope enabled, the rebase form shows the number of moving changes and their full list before you choose a destination. Rebase previews mark moving changes in both trees and include the full list below them, even when the graph limits omit some descendants.

## External diff editors and Hunk

For individual files or hunks, open the Space menu and choose **Squash interactively** or **Split interactively**. Squash asks you to choose a destination change first. The app pauses while JJ opens your configured diff editor, followed by your description editor when needed. Save and close the editor to let JJ apply your selection. Cancel using the editor's controls or Ctrl-C. The app resumes and refreshes the graph when JJ exits.

To review a change in [Hunk](https://github.com/modem-dev/hunk/), install its CLI with `npm install -g hunkdiff`, then select the change and choose **Open in Hunk** from the Space menu. The app runs `hunk show` with the selected commit in the repository directory. Close Hunk to return to the app and refresh the graph. Hunk is optional and must be on your PATH.

## Applying edits and splitting files

Errors stay inside the overlay and preserve your input. Success closes it, selects the resulting revision when available, and briefly shows a confirmation above the graph. `e` and `n` skip the overlay: they switch the working copy or create an empty child immediately, select the result, and show the same confirmation; press `u` to preview an undo. The Space menu's **Create child change** also applies immediately; **Edit change** reviews the operation first. The footer contains keyboard hints. If another command or working-copy edit changes the repository before confirmation, the app rejects the stale action.

Rebase can move one change or its descendants. Squash accepts all files or a selected group and lets you keep or replace the destination description. In its description field, Ctrl-D restores the choice to keep the destination text. Split selects whole files for the first change and asks for its description. Then choose **Keep original description** for the second change, or **Edit second description** to enter a replacement (which may be empty). Keeping the original preserves multiline text. Review both descriptions and file groups before applying; undo reverses the entire split in one operation. Enter toggles files in the file-selection menu; select **Continue** when the group is ready.

## Bookmarks, undo, and restore

Drag a local `[bookmark]` label in the log onto another change to preview a move. The destination highlights while dragging. Release to open the confirmation, then press Enter to apply. Escape, dropping outside a change, or dropping on the source cancels. Each bookmark has its own label, so you can move one when several share a change. Press `b` to track or untrack remote bookmarks. Select **Git remotes** from the bookmark browser or action menu to fetch or push. Choose a remote, then **Push bookmark** to select one local bookmark (or a tracked deleted bookmark). The confirmation shows the remote URL, full previous and proposed commit IDs, and JJ’s dry-run report. Enter publishes that exact bookmark; Escape cancels. Fetches and tracking changes also require review. JJ retains its push safety checks; after a rejected push, fetch and review again. Configure authentication through Git credentials or SSH in your terminal. Remote operations time out after 30 seconds; after an interrupted push, fetch to check its outcome before retrying. Pushes cannot be reversed with local undo. Undo applies the inverse of the exact latest operation shown in its preview. Restore returns repository state and local bookmarks to a selected operation. Both preserve remote-tracking state and run without network operations.

## Search, navigation, and descriptions

The initial revision graph loads 200 revisions. Press `Ctrl+L` to load 200 more while preserving selection and scroll. Refresh retains the expanded limit; changing the revset resets it. Search covers the full active revset, including full multiline descriptions and local and remote bookmark names. Text matching ignores case; change and commit IDs match by prefix. Typing previews the first match. Enter keeps the query for next and previous navigation; Escape restores the previous search and selection. Clearing an accepted search keeps the selection and revset. Matching revisions have a `*` marker. Distant targets open a temporary view of up to 40 revisions, including immediate parents and children. A `+` marks context outside the active revset. `Ctrl+O` restores the original selection and scroll position, including after repeated jumps. Search and navigation leave repository state unchanged. Operation history starts with 50 entries and offers **Load older operations**. The app checks for external changes automatically; `Ctrl+R` remains available for an immediate reload. Press Enter to edit the full description in the app. Shift+Enter inserts a newline, Enter saves, and Escape cancels. Alt+Enter also inserts a newline when your terminal does not distinguish Shift+Enter. Pasting preserves line breaks. `D`, or **Edit description in editor** in the Space menu, opens JJ’s configured external editor.

Destination pickers for bookmark moves, rebase, and squash include the full history. Press `/` in a picker to search descriptions, local or remote bookmarks, and ID prefixes; use arrows to move and Enter to choose. Escape clears search first, then cancels the picker. Press `/` during inline rebase or squash to find a distant destination and reveal it in the graph before previewing.

## Automatic refresh

The app also refreshes when your terminal reports focus returning. Open prompts retain their drafts and defer that refresh until they close. Returning focus invalidates a pending operation review; press `p` to prepare it again.

While browsing, the app checks for changes every two seconds. It runs `jj status` to snapshot pending working-copy edits and checks the operation ID before reloading. Automatic updates preserve the active revset, accepted search, selection where possible, graph and preview scroll, temporary navigation views, and pane visibility. Checks pause during prompts, action reviews, drags, and external tools; stale in-flight results are discarded if you interact. Failed checks report an error and retry. No filesystem watcher is required.

## Conflict resolution

For a conflicted revision, choose **Resolve conflicts** from the Space menu to open JJ’s configured merge tool. The app resumes and refreshes after either editor exits, including after a failure or cancellation, and keeps the edited revision selected when it remains in the current view. JJ controls saving and cancellation; unsupported conflicts and editor failures are reported in the app.

The log uses jj's native ancestry lines and node symbols. An in-app hunk editor is not implemented.


## Custom keybindings

Create `$XDG_CONFIG_HOME/jj-evolved/keybindings.json` (or
`~/.config/jj-evolved/keybindings.json` when `XDG_CONFIG_HOME` is unset), then
restart the app. The file is optional. For example:

```json
{
  "preset": "jjui",
  "bindings": {
    "down": ["x", "down"],
    "up": ["k", "up"],
    "status": ["s"],
    "help": ["h"]
  }
}
```

`preset` chooses the base layout: `jjui` (the default) follows
[jjui](https://github.com/idursun/jjui), and `legacy` restores the keys
jj-evolved used before adopting it (`d` describe, `r` refresh, `R` rebase,
`a` absorb, `s` status, `/` revset, `Ctrl+F` search, `L` load more, `f` files,
Enter for the diff preview). Each supplied array replaces all keys for that
action; omitted actions retain the preset's defaults and `[]` disables an action. Help and the footer show the effective
bindings. Unknown fields/actions, invalid keys, and duplicate keys fail startup
with an error naming the file and conflict. To reuse an assigned key, override
both actions in the same file.

Keys are case-sensitive printable ASCII characters (`"r"` and `"R"` differ),
`ctrl+a` through `ctrl+z`, or the names `up`, `down`, `left`, `right`, `tab`,
`pageup`, `pagedown`, `home`, `end`, `space`, `escape`, `return`, `f1`–`f12`.
Use named keys for terminal aliases: `ctrl+i`, `ctrl+j`, `ctrl+m`, and `ctrl+h`
are rejected. `ctrl+z` is reserved by the terminal and `ctrl+c` always quits.
Alt/Meta combinations and key sequences are not supported.

Available actions and defaults:

| Action | `jjui` preset | `legacy` preset |
| --- | --- | --- |
| `down`, `up` | `j`/`down`, `k`/`up` | same |
| `focus`, `pageUp`, `pageDown` | `tab`, `pageup`, `pagedown` | same |
| `previewUp`, `previewDown` | `ctrl+p`, `ctrl+n` | unbound |
| `previewHalfUp`, `previewHalfDown` | `ctrl+u`, `ctrl+d` | same |
| `status`, `refresh`, `filter`, `loadMore` | `w`, `ctrl+r`, `L`, `ctrl+l` | `s`, `r`, `/`, `L` |
| `search`, `nextMatch`, `previousMatch` | `/`, `'`, `"` | `ctrl+f`, `ctrl+n`, `ctrl+p` |
| `workingCopy`, `parent`, `child`, `return` | `@`, `[`, `]`, `ctrl+o` | same |
| `clearSearch`, `diff`, `togglePreview` | `escape`, `d`, `p` | `escape`, `return`, `p` |
| `describe`, `describeExternal`, `edit`, `new` | `return`, `D`, `e`, `n` | `d`, unbound, `e`, `n` |
| `rebase`, `squash`, `split`, `abandon` | `r`, `S`, `s`, `a` | `R`, `S`, unbound, unbound |
| `rebaseScope` (inline rebase only) | `tab` | same |
| `absorb`, `evolution` | `A`, `v` | `a`, `v` |
| `actions`, `bookmarks`, `git`, `operations` | `space`, `b`, `g`, `o` | `space`, `b`, unbound, `o` |
| `undo`, `files`, `theme`, `help`, `quit` | `u`, `l`/`right`, `t`, `?`, `q` | `u`, `f`, `t`, `?`, `q` |

Unbound actions stay reachable from the Space menu. `rebaseScope` toggles
descendants while choosing an inline rebase destination. Because it is only live
there, it may share a key with a browse action that is not: the default Tab is
also `focus`. It cannot share a key with `loadMore` or `togglePreview`, which stay
active during destination choice. Fixed inline controls (`j`/`k`, arrows up/down, Page Up/Down, `/`, Enter, and Escape) are reserved for destination navigation and cannot be assigned to these three actions.

Overrides apply while browsing, including movement in the preview pane. Inline
destination choice honours `rebaseScope`, `loadMore`, and `togglePreview`. Prompts,
menus, destination selection, and history forms otherwise retain their displayed
fixed controls: `j`/`k` or arrows to choose, Enter to submit, Escape to cancel, and
their existing field/preview controls. Text inputs retain normal editing keys; typing a
custom browse shortcut inserts text. Ctrl-C remains available everywhere.

## Revset completion

In the `L` revset prompt, type a bookmark or function prefix and press Tab to insert a suggestion.
Tab cycles forward and Shift-Tab cycles backward; the visible list tracks the
selection. Enter applies the expression, and Escape cancels the prompt. Invalid
expressions leave the current history view intact so you can correct the input.
Completion replaces only the token at the cursor, preserving the surrounding
expression. Local and remote bookmark suggestions use the most recently loaded
repository state; press `Ctrl+R` before opening the prompt to refresh that state.

Suggestions are computed locally without running commands or contacting remotes.
Bookmark names are quoted when needed, and a small list of common built-in jj
functions is included. This is token completion, not a full revset parser: custom
aliases, argument-aware suggestions, and syntax validation remain jj's job.
