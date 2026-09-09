# MVP implementation

The current build implements the local history-management workflows in the [feature specification](features.md). Editing both split descriptions in one flow remains open.

## Implemented workflows

- Selectable revision graph and changed-file browsing, colored diffs, status, revset filtering, and refresh.
- Describing a change, creating a child, editing a change, and abandoning a change.
- Rebasing one revision or a revision with its descendants onto a selected destination.
- Squashing all files or a selected file group, with an explicit description choice.
- Splitting selected whole files into a first change while preserving the original description on the second.
- Listing local and remote bookmarks and creating, moving, renaming, or deleting local bookmarks.
- Operation-history browsing with incremental expansion, operation inspection, undo, and restore.
- Action discovery through Space and help, confirmation previews, stale-action rejection, and conflict markers with CLI resolution guidance.

## Architecture

The entry point opens `Repository`, creates an OpenTUI renderer, and starts `createApp(renderer, repository)`. Tests supply a real renderer and a repository in a temporary directory.

The repository module owns subprocess arguments, JSON templates, validation, command timeouts, and operation previews. `Mutation` is a discriminated union of supported actions. `prepare(action)` returns a `PreparedMutation` containing the action, the current operation ID, and review text. `apply(prepared)` checks that repository state still matches before running the command. Rebase and squash previews run the same command arguments at the captured operation with `--no-integrate-operation`, then render `jj log` at the returned operation. These detached operations create repository objects but leave the live operation log and working copy unchanged. Context includes up to 200 original affected changes, with up to 40 displayed revisions and their immediate parents. Local bookmark names omit remote synchronization decorations. Newly generated change IDs can differ when the operation is applied. Preview preparation rejects invalid operations before confirmation.

Preparing an action snapshots pending working-copy edits and verifies that revision targets remain visible. Before applying, the repository snapshots again and compares operation IDs. An external command or file edit invalidates the confirmation. This check does not lock out external jj processes; jj still owns concurrency handling if another process writes during execution.

Revision commands use captured full commit IDs. File selections use literal root-relative filesets, so spaces and glob characters in filenames retain their meaning. Bookmark deletion uses an exact name pattern. Commands use argument arrays without a shell, disable paging and color, and time out after 30 seconds.

Operation and bookmark inspection use read-only command options. Undo applies the inverse of the exact latest operation displayed in the preview. Restore selects an explicit operation ID. Both restore repository state and local bookmarks while preserving remote-tracking state.

`snapshot(revset)` reads graph-prefixed JSON metadata and a marked description row from one `jj log` command. The adapter retains jj's graph prefixes and connector rows. Word wrapping is disabled for the metadata protocol. Each node and description row references its parsed revision.

`RevisionLog` displays the graph in a scrollable pane, highlights a selected revision's two rows, and skips connectors during keyboard navigation. Lines truncate to the available width instead of wrapping and breaking the graph. The app owns selection, focus, inputs, menus, and confirmations. Prompt variants distinguish browsing, text entry, selection, confirmation, and a history-editing form. A selected action captures its source before opening subsequent pickers. Preview requests use a generation counter so older responses cannot replace a newer selection. A busy state serializes writes through refresh.

`TreeComparisonView` renders captured before/after graph text in equal-width columns inside the shared preview scroller. Graph lines do not wrap; long labels are clipped. Both confirmation dialogs and history forms use this view.

`ActionOverlay` supplies the shared dialog layout: source context, fields, local feedback, preview, and keyboard hints. Quick inputs use a smaller height. The background graph stays visible and its mouse selection is disabled until the overlay closes.

`HistoryForm` owns rebase and squash drafts. Destination, scope or files, description, and Apply remain in one form. Editing a field returns to that form, and a new preview invalidates the prior prepared operation. Failed operations preserve the draft and require a refreshed preview. Quick-input failures return to the editable input with its value intact. Success closes the overlay and shows a short result message above the graph.

After a successful write, refresh errors say that the operation succeeded and direct the user to refresh instead of repeating the action. Working-copy-changing actions reset the filter to `all()` and select the working copy. Other actions preserve the active revset and recover selection by commit ID, then a unique change ID.

## Current limits

Revision lists and destination pickers load at most 200 revisions. Operation history starts with 50 entries and can load more. Refresh is manual. Diffs are buffered in memory. Inputs are single-line; squash can preserve an existing multiline description without flattening it. The split flow preserves the second description rather than editing it.

A broader destination search and an integrated conflict editor are not implemented. Conflict resolution continues through the jj CLI.

## Verification

Verified on macOS with Bun 1.4.2 and jj 0.45.1:

- `bun run typecheck` passes.
- `bun test` passes 24 tests with 126 assertions.
- Repository tests verify bookmark targets, edit/abandon behavior, operation inspection without writes, undo/restore, and rebase parent relationships in both move modes.
- File-level split and squash tests compare the final repository contents with the original. Literal filenames include spaces and wildcard characters. Partial squash verifies that unselected files remain in the source.
- Graph tests compare branches, merges, filtered ancestry, and empty results with native jj output. Renderer tests verify commit selection, narrow layout, and scrolling through long graphs.
- Tests cover rebase-created conflicts, immutable targets, external operations and file edits invalidating confirmations, and stale asynchronous diffs.
- Overlay tests cover 80-column input placement, graph visibility, correcting duplicate bookmark names, and preserving rebase fields after stale-confirmation failures.
- Keyboard tests drive bookmark creation/rename/undo, operation history, cancellation, stale confirmation, and a complete split-then-squash flow through the actual OpenTUI renderer.
- `bun run demo` starts in a real PTY. The action menu renders and Ctrl-C restores the terminal and exits successfully.

Tests create disposable repositories and never initialize the source checkout as a jj workspace.
