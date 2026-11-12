# Usage guide

Detailed controls and workflows for [jj-evolved](../README.md). Press `?` in the app for keyboard help.

## Themes

Press `t` to open the theme picker. Use `j`/`k` or the arrow keys to preview each theme across the app. Enter saves your choice; Escape restores the previous theme.

Available themes are Terminal, Dark, Light, Gruvbox Dark, Tokyo Night, Catppuccin Mocha, and Vesper. The default Terminal theme inherits your terminal's foreground, background, and ANSI palette. When your terminal reports its colors, the selected revision gets a band mixed from its background and foreground, and diff additions and deletions get faint green and red tints. Otherwise the selection is marked with a thin bar and bold description, and diff lines with colored signs, preserving the terminal background.

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
| `L` | Enter a revset; empty restores the `jj log` default (`revsets.log`) |
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
| `Ctrl+S` / `Ctrl+D` | Save the description editor (Enter inserts a newline) |
| `D` | Edit the description in JJ's configured editor |
| `e` | Switch the working copy to the selected revision immediately; `u` previews an undo |
| `n` | Create an empty child of the selected revision immediately; `u` previews an undo |
| `r` / `S` | Start inline rebase / squash; choose a destination in the graph and Enter previews |
| Tab (during inline rebase) | Toggle whether descendants move with the change |
| `s` | Split selected files into a first change |
| `a` | Preview abandoning the selected change |
| `A` | Preview absorbing the selected change's edits into mutable ancestors |
| `v` | Browse the selected change's evolution and preview each version's rewrite diff |
| Space | Open the action menu, grouped into Edit, History, Bookmarks & remotes, Inspect and Repository; each item shows its effective key and `/` filters by name |
| `B` | Set a bookmark by typing its name in the selected change's row. A new name is created at once (`u` undoes it); Tab through the local bookmarks listed under the row to move one here, which opens a review first |
| `b` | Browse bookmarks with their sync state; move, rename, delete, push, track, or untrack |
| `g` | Git menu: `p` publishes the selected change, `f` fetches, `F` fetches from every remote, `s` syncs the selected stack with trunk, `r` browses remotes |
| `o` | Browse operation history, inspect an operation, or restore its state |
| `u` | Preview undo of the latest operation |
| `l` / Right | Expand the selected revision's changed files beneath it in the graph; `j` / `k` preview one file at a time, `h` / Left / Escape collapses |
| `d` | Return to the revision's diff preview |
| `t` | Preview and save a theme |
| `?` | Open scrollable help; Escape or `?` closes it |
| `Ctrl-E` | Show the last error in full; Escape or `d` returns to the diff |
| Escape | Go back one overlay level, or cancel the top-level prompt |
| `q`, Ctrl-C | Quit |

## Preview and overlays

Press `p` (the `togglePreview` binding) while browsing or choosing an inline rebase/squash destination to toggle the right-hand preview. While it is hidden, Tab keeps focus on the graph. `d` or `w` reopens it for the revision preview or status. `?` opens a separate help overlay even when the preview is hidden. Escape returns from status to the change preview. The choice lasts for the current session.

The Space action menu groups actions by task and displays the effective shortcut beside each item (`—` means no shortcut). `j`/`k` and arrows skip section headers. Press `/` to filter action names; empty sections disappear. Escape clears the filter first, then closes the menu.

Menu actions open in overlays, leaving the graph and selected revision visible behind them. Quick text edits use a smaller dialog. Use `j` and `k` to choose an item and Enter to select it. Page Up and Page Down scroll the overlay preview. Escape returns to the previous picker with its selection restored; `h` and Left do the same while choosing an item. Text prompts and confirmations opened from a picker also return one level on Escape. The hint shows **Esc back** when a parent exists and **Esc close** or **Esc cancel** at the top level. Applying an action closes the entire flow.

## Changed files

Press `l` or Right, or choose **Browse changed files** from the Space menu, to expand the selected revision's changed files beneath it in the graph. The rest of the graph stays in view, the revision is marked `▾`, and the pane is titled with its change ID. Each file shows a status letter: `A` added, `M` modified, `D` deleted, `R` renamed, `C` copied. A long list scrolls within a third of the pane. `j` and `k` move through the files, and the preview shows only the selected file's diff with the path as its title. Enter reveals the diff if hidden and moves focus to it so `j` and `k` scroll it; Tab switches focus back. Page Up / Page Down, `Ctrl+N` / `Ctrl+P`, `Ctrl+D` / `Ctrl+U`, and `p` control the preview as usual. `h`, Left, Escape, or `l` again collapses the list with the same revision selected and reloads its full diff. An empty change shows "Empty change. No changed files." beneath it. Automatic refresh continues while the list is open: when the change is rewritten, for example as you edit files in the working copy, the list reloads and keeps the selected file; when the change leaves the graph, the list collapses.

## Absorb

Press `A`, or choose **Absorb into ancestors** from the Space menu, to distribute fixes across a stack. JJ chooses the mutable ancestors that last changed the affected lines. The preview shows the actual proposed operation changes and the edits remaining in the source. Edits JJ cannot assign stay in the source. Enter applies the preview; Escape cancels; `p` refreshes a stale preview. An emptied source with no description is abandoned. The app keeps the source selected if it survives, otherwise selects the working copy.

## Change evolution

Press `v`, or choose **Change evolution** from the Space menu, to browse previous versions of a change. Use `j` and `k` to select a version and Page Up or Page Down to scroll its patch. The patch shows what that version changed relative to its predecessors, including description edits. The earliest version shows its creation patch. **Load older versions** expands beyond the initial 50 entries. Browsing stays at the repository state captured when the view opened and does not snapshot pending edits or switch the working copy. Close the view to resume automatic refresh; reopen it to include newer work.

## Rebase and squash

For inline rebase or squash, press `r` or `S` on the source, then use `j`/`k` or arrows to choose a destination. Enter opens a preview; Enter again applies. Escape returns from the preview to destination selection, or cancels from the graph. The source stays marked with `●`. For rebase, the hint shows a checkbox such as `[ ] include descendants (3 changes) · Tab toggle`; Tab (the `rebaseScope` binding) checks or clears it. With descendants included, every moving change is marked `●`, and the hint shows the total count and how many are outside the loaded graph. Turning the option off clears the descendant markers. Inline squash moves all files and keeps the destination description. Errors keep the mode active so you can adjust the destination or scope.

Rebase and squash previews show the current tree on the left and the proposed tree on the right with native graph lines, local bookmarks, and conflict markers. Both columns scroll together; long labels are clipped to preserve tree alignment. The view includes relevant descendants and parents, up to 40 revisions. Previewing does not change the working copy or live operation log.

The rebase and squash menu forms show the source, destination, options, and preview in one form. Enter edits the selected field. Choose **Apply** after reviewing the preview. You can change a field without restarting the action. Press `p` to refresh a stale preview. With descendant scope enabled, the rebase form shows the number of moving changes and their full list before you choose a destination. Rebase previews mark moving changes in both trees and include the full list below them, even when the graph limits omit some descendants.

## External diff editors and Hunk

For individual files or hunks, open the Space menu and choose **Squash in diff editor** or **Split in diff editor**. Squash asks you to choose a destination change first. The app pauses while JJ opens your configured diff editor, followed by your description editor when needed. Save and close the editor to let JJ apply your selection. Cancel using the editor's controls or Ctrl-C. The app resumes and refreshes the graph when JJ exits.

To review a change in [Hunk](https://github.com/modem-dev/hunk/), install its CLI with `npm install -g hunkdiff`, then select the change and choose **Open in Hunk** from the Space menu. The app runs `hunk show` with the selected commit in the repository directory. Close Hunk to return to the app and refresh the graph. Hunk is optional and must be on your PATH.

## Applying edits and splitting files

Errors stay inside the overlay and preserve your input. Success closes it, selects the resulting revision when available, and briefly shows a confirmation above the graph. `e` and `n` skip the overlay: they switch the working copy or create an empty child immediately, select the result, and show the same confirmation; press `u` to preview an undo. The Space menu's **New child** also applies immediately; **Edit (make working copy)** reviews the operation first. The footer contains keyboard hints. If another command or working-copy edit changes the repository before confirmation, the app rejects the stale action.

Rebase can move one change or its descendants. Squash accepts all files or a selected group and lets you keep or replace the destination description. In its description field, Ctrl-D restores the choice to keep the destination text. Split selects whole files for the first change and asks for its description. Then choose **Keep original description** for the second change, or **Edit second description** to enter a replacement (which may be empty). Keeping the original preserves multiline text. Review both descriptions and file groups before applying; undo reverses the entire split in one operation. Enter toggles files in the file-selection menu; select **Continue** when the group is ready.

## Bookmarks, undo, and restore

Drag a local `[bookmark]` label in the log onto another change to preview a move. The destination highlights while dragging. Release to open the confirmation, then press Enter to apply. Escape, dropping outside a change, or dropping on the source cancels. Each bookmark has its own label, so you can move one when several share a change.

Labels also show how a bookmark stands against its remote. `[name]` is a local bookmark, with its tracked remote at the same change if it has one; the separate `[name@remote]` label is dropped in that case. `[name ↑2]`, `[name ↓1]` and `[name ↑2↓1]` are 2 commits ahead of the tracked remote, 1 behind, and both; the remote's own `[name@remote]` label then sits on the change the remote points at. `[name*]` is on no remote yet, and appears only in a repository that has a remote. An untracked remote bookmark keeps its `[name@remote]` label, and `!` still marks a conflicted bookmark, which shows no counts since it has no single target to count from. The `@git` label of a colocated repository is hidden while it matches the local bookmark, and while the local bookmark is conflicted, since Git then keeps one of the local targets.

Press `b` for the bookmark browser. It lists each bookmark name once and describes its state, naming the remote: in sync, ahead or behind by a number of commits, diverged, local only, untracked on a remote, remote only (tracked or untracked), or conflicted. A conflicted bookmark reads **conflicted with origin**, without counts. The actions depend on that state. A conflicted bookmark is resolved by moving it to one of its targets: **Set to feature@origin** takes a tracked remote's target, and **Keep local** takes the target no remote has (several such targets are listed by commit). Each opens the usual move review. A local bookmark can be moved, renamed or deleted, and pushed when it is ahead or local only; the push applies at once, like every push. A remote bookmark you do not track offers **Track**, and a tracked one offers **Untrack**. Untracking a bookmark you deleted locally cancels its pending deletion: the review says the remote bookmark stays and a later push will no longer delete it. **Delete bookmark** reviews a local deletion and names every remote that tracks the bookmark; press `r` in that review to also delete it on all of them, and `r` again to keep it. Deleting the remote bookmarks is a push that cannot be undone locally, and undo does not bring the local bookmark back after it either: undo reverts the last push, which changes nothing locally. To get the local bookmark back, restore the operation before the deletion from operation history (`o`). The local bookmark is deleted first and the deletion is then pushed to each remote in turn; if a push fails, the error says which remotes already had it deleted and which still have it, and **Push deletion** on that bookmark retries.

Press `g`, then `p`, (or choose **Publish change** from the action menu) to put the selected change on a remote in one step. The app picks the bookmark the way you would: a bookmark already on the change is pushed as it is, so republishing is `g`, `p`. Otherwise the bookmark on the nearest ancestor is advanced to the change and pushed, which covers a new commit on top of a pushed bookmark. An ancestor's bookmark is never inferred from an immutable commit, so a change stacked directly on `main` is not offered "advance main", and a conflicted bookmark is never inferred. With several candidates you choose from a list that also has **Other name…**. With none, a name prompt opens with the name `jj git push --change` would generate (the `templates.git_push_bookmark` setting, `push-<change id>` by default). The Git menu's `p` entry names the bookmark it will use and says when it will advance it; its `n` entry pushes the change under another name. The `publish` action has no default key; bind one in `keybindings.json` to skip the menu. Publishing sets the bookmark, tracks it on the remote, and pushes, without a further confirmation. A publish that would move the remote bookmark backward or sideways stops at a review that leads with a warning and shows whether the bookmark is created, advanced or moved, whether tracking starts, the remote's old and new targets, and every commit that will be published. It uses the `git.push` remote, then `origin`, then the only remote, and asks when none of those applies. Changes JJ refuses to push (no description, conflicts) are rejected before the bookmark is created. If the push itself fails, the local bookmark stays in place and publishing again retries.

In the same menu, `f` fetches from that remote. With two or more remotes, `F` (**Fetch all remotes**, also first in the remote browser) fetches from each configured remote in turn, listing them by name. Its report names each changed bookmark with its remote. If one remote fails or you cancel, the message says which remotes were fetched and which were not, and the fetches that finished are kept. `s` syncs the selected change's stack with trunk: it fetches the same way, and only once the fetch succeeds does it open the Before and After rebase preview for moving the whole stack onto `trunk()`, as `jj rebase -b <change> -d 'trunk()'` would. A failed or cancelled fetch stops there. Enter applies the rebase like any other; Escape leaves the fetch in place and skips the rebase. If the stack is already based on trunk after the fetch, or the repository has no trunk bookmark, the message line says so and no preview opens. A change that is trunk itself or immutable is refused with a message before anything is fetched. A stack with several roots (a merge of separate branches) is not previewed; use `jj rebase -b` in a terminal for it. `r` opens the remote browser, which is also listed as **Git remotes** in the bookmark browser. There, choose a remote, then **Fetch**, or **Push bookmark** to select one local bookmark (or a tracked deleted bookmark). Choosing the bookmark publishes exactly that bookmark, and fetching fetches, without a further confirmation; Escape steps back before then. jj will not create a remote bookmark for a bookmark that already tracks another remote, so such a bookmark is listed as **Track feature@up, then publish this bookmark**: choosing it publishes the bookmark the way `p` does, tracking it on that remote first. A bookmark whose remote counterpart exists but is untracked is listed as **Track feature@origin first**; choosing it explains that jj will not push over the untracked remote bookmark, so track it from the bookmark browser, then push. A push that would delete the remote bookmark, or move it backward or sideways so commits drop off it, stops at a review that leads with a warning; press Enter to push anyway. Tracking changes still require review. When a fetch or push finishes, the graph's status line says what changed, for example `Pushed feature to origin` with the old and new targets, `feature is already up to date on origin`, or which bookmarks a fetch updated. A fetch that leaves a local bookmark conflicted, because it and its remote moved apart, adds a line such as `now conflicted: feature`; resolve it from the bookmark browser. JJ retains its push safety checks; after a rejected push, fetch and push again. Configure authentication through Git credentials or SSH in your terminal; a failed fetch or push says so unless jj refused it locally, in which case jj's own hint is shown alone. Remote operations stop after 10 minutes; while one runs, the footer shows `Esc cancel`, and Escape cancels it sooner. Quitting cancels it too. If you cancel a publish before its push starts, the message says nothing was sent and the tracked local bookmark stays for the next publish. After a push that was cancelled once it started, or was interrupted, fetch to check its outcome before retrying. Pushes cannot be reversed with local undo. Undo applies the inverse of the exact latest operation shown in its preview. Restore returns repository state and local bookmarks to a selected operation. Both preserve remote-tracking state and run without network operations.

## Search, navigation, and descriptions

The initial revision graph loads 200 revisions. Press `Ctrl+L` to load 200 more while preserving selection and scroll. Refresh retains the expanded limit; changing the revset resets it. Search covers the full active revset, including full multiline descriptions and local and remote bookmark names. Text matching ignores case; change and commit IDs match by prefix. Typing previews the first match. Enter keeps the query for next and previous navigation; Escape restores the previous search and selection. Clearing an accepted search keeps the selection and revset. Matching revisions have a `*` marker. Distant targets open a temporary view of up to 40 revisions, including immediate parents and children. A `+` marks context outside the active revset. `Ctrl+O` restores the original selection and scroll position, including after repeated jumps. Search and navigation leave repository state unchanged. Operation history starts with 50 entries and offers **Load older operations**. The app checks for external changes automatically; `Ctrl+R` remains available for an immediate reload. Press Enter to edit the full description in the app. Inside the editor, Enter inserts a newline (Shift+Enter and Alt+Enter do the same), `Ctrl+S` saves, and Escape cancels; if you changed the text, the editor warns and a second Escape discards the edits. `Ctrl+D` also saves, because some terminals reserve `Ctrl+S` for XON/XOFF flow control (`stty -ixon` frees it). Pasting preserves line breaks. `D`, or **Describe in editor** in the Space menu, opens JJ’s configured external editor.

Destination pickers for bookmark moves, rebase, and squash include the full history. Press `/` in a picker to search descriptions, local or remote bookmarks, tags, and ID prefixes; use arrows to move and Enter to choose. The same text is also resolved through jj, so a bookmark, tag, change or commit ID, or a revset such as `heads(::main)` or `latest(mine())` can name the destination even when no text matches. When it names exactly one revision, that revision is listed first and the message shows its change ID and description. A revset that names several revisions, none, or the change being moved is not offered; the message says so, with jj's own error for an unknown name or a syntax error. Enter pressed before jj answers waits for it. Escape clears search first, then returns to the previous picker or closes a top-level picker. Press `/` during inline rebase or squash to find a distant destination and reveal it in the graph before previewing.

## Automatic refresh

The app also refreshes when your terminal reports focus returning. Open prompts retain their drafts and defer that refresh until they close. Returning focus invalidates a pending operation review; press `p` to prepare it again.

While browsing, the app checks the operation ID every two seconds, which catches `jj` commands run elsewhere at little cost. Snapshotting pending working-copy edits scans the working copy and imports Git refs, which is slow on large repositories, so the checks do it only every 30 seconds or once another command has moved the operation ID. Returning focus, `Ctrl+R` and the app's own actions snapshot immediately, and so does the first key or click after two seconds without input, for terminals that don't report focus. An edit saved in another window therefore shows up when you switch back or press a key, or within 30 seconds if you only look. Automatic updates preserve the active revset, accepted search, selection where possible, graph and preview scroll, temporary navigation views, and pane visibility. Checks pause during prompts, the changed-files view, action reviews, drags, and external tools; stale in-flight results are discarded if you interact. Failed checks report an error and retry. No filesystem watcher is required.

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
Alt/Meta combinations are not supported.

### Key sequences

A binding can be up to three keys separated by single spaces, pressed one after
another: `"theme": ["z t"]` or `"saveDescription": ["ctrl+x ctrl+s"]`. After the
first key nothing runs; the footer shows the keys typed so far and every key that
can follow, with the action each one runs. A key that finishes no sequence is
dropped together with the keys before it, and the message line says, for example,
`z j is not bound`. Escape abandons a sequence. There is no timeout. A key cannot
both run an action and start a sequence in the same scope: binding `"theme": ["g t"]`
while `git` keeps `g` is an error, so move `git` to `"g g"` as well. `escape` cannot
be part of a sequence.

### Scopes

Bindings in `bindings` apply wherever the action is used. Add a `scopes` object to
change an action in one place only:

```json
{
  "bindings": { "git": ["g g"], "theme": ["g t"] },
  "scopes": {
    "files": { "down": ["J"], "up": ["K"] },
    "menu": { "back": ["ctrl+b"] },
    "prompt": { "nextCompletion": ["tab", "ctrl+t"], "saveDescription": ["ctrl+x ctrl+s"] }
  }
}
```

| Scope | Where | Actions |
| --- | --- | --- |
| `revisions` | Browsing the revision list and the preview beside it | every browse action in the table below |
| `files` | The changed-files browser | `down`, `up`, `focus`, `pageUp`, `pageDown`, `previewUp`, `previewDown`, `previewHalfUp`, `previewHalfDown`, `togglePreview`, `files`, `back`, `help`, `quit` |
| `destination` | Choosing an inline rebase or squash destination | `down`, `up`, `pageUp`, `pageDown`, `search`, `rebaseScope`, `loadMore`, `togglePreview` |
| `menu` | Action menus, pickers, the theme chooser, help, and the rebase and squash form | `down`, `up`, `back`, `help` |
| `prompt` | The revset prompt, bookmark names, the description editor and quick inputs | `nextCompletion`, `previousCompletion`, `saveDescription` |

Conflicts are checked within each scope, so one key can do different things in
different scopes: by default `Ctrl+N` scrolls the preview while browsing and picks
the next revset suggestion in a prompt. An action named in a scope where it does not
apply, or an unknown scope, is an error. Some keys stay fixed in every scope: arrow
keys always move, Enter chooses or submits, Escape goes back or cancels, PgDn/PgUp
scroll an overlay's preview, and Shift-Tab picks the previous suggestion. Enter and
Escape cannot be bound in menus. In `prompt`, only `tab`, `f1`–`f12` and control keys
can be bound, so every printable key still types; the editing keys `ctrl+a`, `ctrl+b`,
`ctrl+e`, `ctrl+f`, `ctrl+k`, `ctrl+u` and `ctrl+w` are refused too. `back`'s
defaults, `h` and Left, give way to any other action of the same scope bound to them
(a `"help": ["h"]` binding keeps working); bound explicitly, `back` is checked like any
other action. Text typed into a search or filter field is never matched against
bindings, and the rebase and squash form keeps its `p` preview key.

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
| `setBookmark` | `B` | `B` |
| `publish` | unbound | unbound |
| `undo`, `files`, `theme`, `help`, `quit` | `u`, `l`/`right`, `t`, `?`, `q` | `u`, `f`, `t`, `?`, `q` |
| `back` (file browser and menus) | `h`/`left` | same |
| `nextCompletion`, `previousCompletion` (prompts) | `tab`/`ctrl+n`, `ctrl+p` | same |
| `saveDescription` (description editor) | `ctrl+s`/`ctrl+d` | same |

Unbound actions stay reachable from the Space menu, which shows the effective
key for every item and `—` for unbound ones. `rebaseScope` toggles
descendants while choosing an inline rebase destination. Because it is only live
there, it may share a key with a browse action that is not: the default Tab is
also `focus`. It cannot share a key with `loadMore` or `togglePreview`, which stay
active during destination choice. Fixed inline controls (`j`/`k`, arrows up/down, Page Up/Down, `/`, Enter, and Escape) are reserved for destination navigation and cannot be assigned to these three actions.

Text inputs retain normal editing keys; typing a custom browse shortcut inserts
text. Ctrl-C remains available everywhere.

## Revset completion

In the `L` revset prompt, suggestions update as you type: built-in functions with
their argument signatures, configured `revset-aliases` with their definitions,
local and remote bookmarks, and local tags. Tab or Down selects the next
suggestion and Shift-Tab or Up the previous one (Ctrl-N and Ctrl-P also work);
the selection is inserted immediately and the list tracks it. Enter applies the
expression, and Escape cancels the prompt without applying the draft. Invalid
expressions leave the current history view and your input intact so you can
correct it. An empty input restores the `jj log` default revset.

Completion replaces only the token at the cursor, preserving the surrounding
expression. Names that need it are quoted, including each side of a remote
bookmark. Functions and function aliases that take arguments are inserted with
empty parentheses and the cursor between them; completing a name that is already
followed by `(` keeps the existing arguments. Bookmark suggestions use the most
recently loaded repository state; tags and aliases are read when the prompt opens.

Successfully applied expressions are remembered per repository, most recent first
(up to 50), in `$XDG_STATE_HOME/jj-evolved/revset-history.json` (by default under
`~/.local/state`). Several open copies of the app share it without losing each
other's entries, and a file that can't be parsed is kept as a timestamped `.bak`
backup before a fresh one is written. Reopening the prompt lists them before you
edit the current expression; once you type, earlier expressions that extend your
input appear above the token suggestions and replace the whole input when
selected. Suggestions never
contact remotes. This is token completion, not a full revset parser: syntax
validation remains jj's job.

Help shows the active preset (`custom` when file overrides are present). Use j/k or arrows to scroll and PgUp/PgDn to page. Sections separate navigation, preview controls, editing, history, bookmarks, symbols, and fixed prompt keys. Unbound actions available in the action menu are marked `(Space menu)`.

Preset precedence is `--keys PRESET`, then `JJ_EVOLVED_KEYS`, then the file’s `preset`, then `jjui`. File `bindings` overrides apply on top of the selected preset. For example, `bun start --keys legacy` selects the earlier layout without editing the configuration.

Inline rebase and squash retitle and recolor the revisions pane while choosing a destination. Tab adds `(focused)` to the preview title and changes the footer to scrolling controls. Confirmation previews keep the source context and use the operation name, with apply/cancel controls in the bottom hint. Read-only navigation preserves the message line; successful operations use a short `Ready.` message. Errors show their first line and the full-error shortcut. `lastError` is rebindable and defaults to `ctrl+e` in both presets; it also retains errors reported inside action overlays.
