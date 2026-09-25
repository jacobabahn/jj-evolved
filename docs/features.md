# jj-evolved feature specification

## Product

jj-evolved is a keyboard-driven terminal workspace for Jujutsu. Its MVP supports the local development workflow: inspect changes, edit history, manage bookmarks, and recover from mistakes through operation history.

The application uses Bun, TypeScript, and OpenTUI.

## MVP scope

This table defines the target MVP. The current build includes repository opening, a selectable revision graph, file and diff browsing, status, revsets, descriptions, new/edit/abandon actions, rebase, squash, absorb, file-level split, change evolution, local bookmark management, reviewed remote fetch/push and tracking, and operation history with inspection, undo, and restore.

The graph preserves jj's native branch, merge, and omitted-history lines. Split accepts descriptions for both resulting changes, with an option to preserve the original description on the second. History loads 200 revisions initially and expands with `Ctrl+L`; destination pickers search all revisions, while operation history can load beyond its initial 50 entries. The requirements below remain the completion criteria.

| Feature | Behavior | Acceptance condition |
| --- | --- | --- |
| Open a repository | Use the current directory or an explicit path. | A nested workspace directory resolves to its repository root. Missing `jj` and non-jj directories produce actionable errors. |
| Browse revisions | Load revisions in batches of 200 in topological order, with descriptions, short change IDs, bookmarks, and working-copy/conflict markers. | Arrow keys and `j`/`k` change the selection and its preview. Full commit IDs distinguish divergent versions of one change. |
| Search revisions | `/` searches every revision in the active revset by description, bookmark, or ID prefix. | Live previews, marked matches, wrapping next/previous controls, cancellation, and explicit empty results work at 80×24. Clearing search preserves the revset. |
| Navigate ancestry | `@` selects the working copy; `[` and `]` select a parent or child. | Multiple relatives open a chooser, including filtered relatives. Distant targets appear in a temporary view with excluded context marked. `Ctrl+O` restores the original view. Navigation does not write repository state. |
| Inspect a change | Show metadata and the selected revision's Git-format diff. | Empty changes have an explicit empty state. The preview scrolls independently. |
| Toggle preview | `p` hides or shows the right-hand pane while browsing or choosing an inline destination. | The graph fills the available width when hidden; focus stays on visible content. Enter, status, and help reopen the pane. Confirmation prompts keep `p` for refreshing previews. |
| View status | Show the actual `jj status` output. | `w` switches the preview to working-copy status. |
| Filter history | Enter a Jujutsu revset with `L`. An empty input restores `all()`. | Invalid input shows jj's error, preserving the previous list and filter. No matches shows an empty state. |
| Refresh | Check every two seconds while browsing; `Ctrl+R` reloads immediately. | Detect external operations and working-copy edits. Preserve selection, accepted search, filter, scroll, and temporary views. Defer during prompts, drags, and actions; discard stale asynchronous reads and stop polling on disposal. |
| Describe | Enter opens a multiline text area. Shift+Enter or Alt+Enter inserts a newline, Enter saves, and Escape cancels. `D` or **Edit description in editor** opens JJ’s external editor. | The description is passed literally, including quotes and shell metacharacters. Existing paragraphs and pasted newlines are preserved. Saving, cancellation, and editor failure return to a refreshed app without switching the working copy. |
| Resolve conflicts | The Space menu offers **Resolve conflicts** for conflicted revisions. | Launch JJ’s configured merge tool against the selected revision; refresh on exit while preserving the current filter and selection where possible. |
| Create a change | `n` opens a confirmation to create an empty child of the selected revision. | Enter runs `jj new`, resets the filter to `all()`, and selects the new working-copy change. Escape leaves the repository unchanged. |
| Navigate ancestry | Show a selectable revision graph with parent relationships, merges, bookmarks, and working-copy/conflict markers. | Each selectable node maps to a full commit ID. Filtering and omitted ancestors do not suggest relationships that do not exist. |
| Browse changed files | List files changed in the selected revision and preview an individual file's diff. | Added, modified, deleted, renamed, binary, and conflicted files have readable states. Returning to the full diff preserves revision selection. |
| Edit a change | Make the selected revision the working-copy change. | Show the target before applying. Refresh the working-copy marker and status after success; show jj's rejection without claiming success. |
| Search destinations | `/` filters destination pickers across the full history by description, bookmark, or ID prefix. | Rebase, squash, and bookmark moves can select revisions beyond the initial 200; inline actions can reveal a distant destination. Escape clears filtering before leaving the picker. |
| Rebase | Move a selected revision or a revision with its descendants onto a chosen destination. | Descendant scope marks every loaded moving revision with `●`, shows the total and any count outside the graph, and includes an uncapped list in confirmation. Both preview trees mark moving changes. Scope toggles and cancellation update or clear markers. Enter applies, Escape cancels, and the refreshed graph reflects the resulting parent relationships and conflicts. |
| Squash | Move all changes, or selected files, from a source revision into a chosen destination. | Preview the affected files and describe what happens to the source revision. Let the user choose the resulting description. Tests verify both revisions' resulting contents. |
| Absorb | Distribute edits from the selected revision into mutable ancestors using JJ's automatic attribution. | Preview the actual operation changes and source leftovers before confirmation. Handle no-op results and source abandonment explicitly. Reject stale selections and previews. Preserve the working-copy files during projection. |
| Browse change evolution | List historical versions of the selected change and preview their native evolution patches. | Use full commit IDs to distinguish versions. Include description changes and correct comparisons for multiple predecessors. Load beyond 50 versions without changing the captured operation. Reads leave pending working-copy edits and the live operation unchanged. |
| Split | Divide a revision into two sequential changes by selecting whole files and supplying descriptions. | Preview both groups before applying. Each resulting change contains the intended files, and their combined result preserves the original tree. Hunk-level splitting is deferred. |
| Abandon | Remove a selected mutable revision from visible history. | Show the target and affected descendants before confirmation. Refresh the graph and report conflicts after success. Escape performs no write. |
| Manage bookmarks | List local and remote bookmarks; create, rename, move, and delete local bookmarks. | Select bookmark targets from revisions. Show the old and new targets before moving a bookmark. Remote entries expose tracking status and reviewed track/untrack actions; the synthetic `@git` entry remains informational. |
| Fetch and push | Select a named remote; fetch or push one explicitly selected bookmark. | Preview the remote URL and exact old/new push targets with JJ dry-run output. Support tracked bookmark deletions. Reject stale operations, changed remote URLs, and unexpected remote targets; preserve diagnostics and explain authentication/retry steps. Local undo does not undo a push. |
| Browse operation history | Show operation IDs, descriptions, timestamps, and the current operation, with inspection of an operation's repository changes. | Navigate beyond the first page. Inspection leaves the current repository operation unchanged. |
| Undo and restore | Undo the latest operation or restore the repository to a selected operation. | Preview the exact operation and explain undo versus restore. Require confirmation and refresh revisions, bookmarks, and operation history after success. A newer external operation invalidates the preview and requires review again. |
| Inspect conflicts | Identify conflicted revisions and files and display the available conflict detail. | Conflicts introduced by history edits remain visible after refresh. Explain how to continue resolution with the jj CLI. An integrated conflict editor is deferred. |
| Discover controls | `?` displays the complete keyboard reference. | Prompts have visible submit/cancel hints. `q` and Ctrl-C restore the terminal. |
| Handle failures | Show errors in the app and keep navigation available. | Mutations cannot overlap. Stale asynchronous previews never replace the current selection's preview. |

## Interaction

The header identifies the repository and active revset. The left pane contains selectable revisions. The right pane contains revision metadata, file diffs, status, operation details, or help. Bookmark and operation-history views are reachable through the keyboard controls. The footer contains keyboard hints. Menu action progress and errors appear inside overlays; inline action progress and errors appear above the graph. Success briefly appears above the graph near the resulting selection. Tab changes pane focus. Page Up and Page Down scroll the preview.

The revision list uses jj's native graph layout. Revision nodes are selectable, connector and omitted-history rows preserve their positions, and parent commit IDs also remain visible in revision details. The interface must remain usable at 80 columns by 24 rows. Wider terminals show more description and diff context.

Menu actions open in overlays with the source revision named inside and the graph visible behind. Quick inputs use a smaller dialog. Rebase and squash show destination, options, and preview together in an editable form, so changing a destination does not require restarting a sequence. Escape cancels before execution. Failures keep the overlay open and preserve inputs. Success closes the overlay and selects the resulting revision when available. File selection for squash and split is explicit; selecting a revision alone never implies selecting only some of its files.

Mutation targets are captured when the preview opens. If repository state changes before confirmation, refresh the preview before applying. After a successful operation, refresh the affected views and select the resulting change where it remains visible. A failed refresh after a successful write must report that the write succeeded so retrying does not repeat it.

`r` and `S` start inline rebase and squash. The source stays marked in the graph while the cursor selects a destination. Enter opens a preview and Enter again applies. Escape returns from the preview to destination selection, preserving the source and scope; Escape in the graph cancels. `s` includes rebase descendants and `r` returns to the single change. Inline squash moves all files and keeps the destination description. Errors preserve the mode and source for correction. Menu forms provide the additional options and previews. Both flows show Before and After trees side by side before applying, including relevant descendants, old and new parents, local bookmarks, and conflict markers, up to 40 revisions.

`A` previews absorb for the selected revision. Its confirmation shows the projected operation patch and the remaining source patch. After applying, selection follows the source if it survives; otherwise the app resets the filter and selects the working copy. `v` opens change evolution, where selecting a version previews its content and description changes. Both features are also available from Space. Evolution uses a fixed operation for all pages and previews until the view is closed.

Space opens the action menu. `e` switches the working copy to the selected revision immediately, without a confirmation prompt. `a` previews abandon, `s` starts a file split, `d` returns to the diff, `b` opens bookmarks, `g` opens Git remotes, `o` opens operation history, `u` previews undo, and `l` or Right opens changed files. These are the default browse bindings, which follow jjui; a `legacy` preset restores jj-evolved's earlier keys. Menu items use arrow keys or `j`/`k` and Enter. A validated `keybindings.json` file under the XDG configuration directory can replace or disable them; the keyboard reference, footer, and action hints show the effective mappings. Modal controls and text editing remain fixed. See the README for the schema and complete action list.

Commands run through the installed `jj` executable with argument arrays, paging disabled, and color disabled. Repository data is parsed through an explicit JSON template, independent of a user's log template. Jujutsu remains responsible for immutable revisions and operation validation. Ordinary jj commands can snapshot working-copy files as part of their normal behavior.

## Outside the MVP

- Adding/removing remote configuration, an in-app credential manager, and bulk pushes. Configure authentication with Git credentials or SSH in the terminal.
- In-app hunk editing and an integrated conflict-resolution editor. Interactive squash and split use JJ's configured external diff editor.
- Full revset language completion (custom aliases and argument-aware suggestions) and custom themes. Basic completion for bookmarks and common functions is implemented.
- Event-driven filesystem watching; automatic refresh uses polling.
- Cross-platform and older-jj compatibility guarantees beyond the verified environment.

## Delivery checks

Run type checking and automated tests against disposable repositories. Verify real `jj` output for revision discovery, diffs, revsets, descriptions, and new changes. For rebase, squash, split, edit, and abandon, assert the resulting parent relationships, working-copy target, descriptions, and file contents. Verify bookmark targets and operation-history effects directly in the repository. Drive the actual OpenTUI renderer with keyboard events to check navigation, prompts, cancellation, help, and refresh. Include branching and merge histories, immutable targets, conflicts, cancellation, stale previews, and external operations between preview and confirmation. Verify undo and restore using known repository states. The tests must never initialize or mutate the source checkout as a jj workspace.

The first verified environment is macOS with Bun and jj 0.45.1. Compatibility with older jj releases and other platforms needs a separate test matrix.

## MVP delivery sequence

1. Complete ancestry-graph navigation, changed-file browsing, and action discovery.
2. Add editing an existing change and local bookmark management.
3. Add operation-history inspection, undo, and restore so history edits have an in-app recovery path.
4. Add rebase, squash, file-level split, and abandon with previews and conflict inspection.
5. Verify the complete workflow against disposable repositories and update the implementation record.

The current build implements the action menu and the local history-management workflows. The split flow reviews both descriptions and file groups before applying them in one operation.

## References

- [Jujutsu CLI reference](https://docs.jj-vcs.dev/latest/cli-reference/)
- [Jujutsu template language](https://docs.jj-vcs.dev/latest/templates/)
