# MVP implementation

The current build implements the local history-management workflows in the [feature specification](features.md). The split flow accepts descriptions for both resulting changes.

## Implemented workflows

- Selectable revision graph and changed-file browsing, colored diffs, status, revset filtering, and refresh.
- Describing a change, creating a child, editing a change, and abandoning a change.
- Rebasing one revision or a revision with its descendants onto a selected destination.
- Squashing all files or a selected file group, with an explicit description choice.
- Splitting selected whole files with descriptions for both changes, optionally preserving the original description on the second.
- Listing local and remote bookmarks and creating, moving, renaming, or deleting local bookmarks.
- Named-remote fetch, exact-bookmark push with full target IDs and JJ dry-run review, and remote bookmark tracking/untracking.
- Operation-history browsing with incremental expansion, operation inspection, undo, and restore.
- Absorb with a projected operation patch, remaining source edits, and confirmation.
- Change evolution with incremental expansion and native patches for individual historical versions.
- Action discovery through Space and help, confirmation previews, stale-action rejection, and conflict markers with CLI resolution guidance.

## Architecture

The entry point opens `Repository`, creates an OpenTUI renderer, and starts `createApp(renderer, repository)`. Tests supply a real renderer and a repository in a temporary directory.

The repository module owns subprocess arguments, JSON templates, validation, command timeouts, and operation previews. Callers import `repository/repository.ts` for operations and `repository/model.ts` for domain types. Internal modules own command execution, log parsing, mutation arguments, projected trees, and external tool lifetime. Projected previews and apply share command construction through `mutationArgs`.

File-level split collects both descriptions before confirmation. When replacing the second description, a temporary noninteractive description editor supplies both reviewed messages to one `jj split --editor` transaction. Keeping the original uses JJ’s native preservation behavior. Temporary files are removed after execution, and undo reverses the complete split.

`Mutation` is a discriminated union of supported actions. `prepare(action)` returns a `PreparedMutation` containing the action, the current operation ID, and review text. `apply(prepared)` checks that repository state still matches before running the command.

Rebase and squash previews run the same command arguments at the captured operation with `--no-integrate-operation`, then render `jj log` at the returned operation. These detached operations create repository objects but leave the live operation log and working copy unchanged. Context includes up to 200 original affected changes, with up to 40 displayed revisions and their immediate parents. Local bookmark names omit remote synchronization decorations. Newly generated change IDs can differ when the operation is applied. Preview preparation rejects invalid operations before confirmation.

Preparing an action snapshots pending working-copy edits and verifies that revision targets remain visible. Before applying, the repository snapshots again and compares operation IDs. An external command or file edit invalidates the confirmation. This check does not lock out external jj processes; jj still owns concurrency handling if another process writes during execution.

`rebaseScope` reads the source and all descendants at a fixed operation without the main graph's 200-revision limit. Inline rebase and the history form mark scope members by full commit ID. Confirmation recomputes the scope at its captured operation and includes every member in the summary. The projected trees use stable change IDs to mark the corresponding before and after versions. The form refreshes scope with its preview; request counters and disposal checks prevent late reads from restoring old markers.

Revision commands use captured full commit IDs. File selections use literal root-relative filesets, so spaces and glob characters in filenames retain their meaning. Bookmark deletion uses an exact name pattern. Commands use argument arrays without a shell, disable paging and color, and time out after 30 seconds.

Operation and bookmark inspection use read-only command options. Undo applies the inverse of the exact latest operation displayed in the preview. Restore selects an explicit operation ID. Both restore repository state and local bookmarks while preserving remote-tracking state.

Absorb uses `confirm({ kind: "absorb", revision })` through the existing mutation flow. Its projection shares the detached-operation helper with rebase and squash. The preview combines JJ's distribution report, `op diff` for the projected result, and the resulting source diff. A no-op states that no edits move. Applying uses the same captured source commit and the standard stale-operation check. Target validation resolves the visible versions of a change and checks the captured commit ID; resolving a full commit ID alone can still find an obsolete version.

The evolution picker calls `Repository.evolution(revision, options)` for an `EvolutionPage` containing `operationId`, `entries`, and `hasMore`. Each `EvolutionEntry` contains its commit ID, description, operation description, and time. The repository reads one extra row to detect another page. Later pages retain the first page's operation ID. `Repository.evolutionDiff(operationId, entry)` uses one-entry `jj evolog --patch`, which handles actual predecessor relationships and description patches. Adjacent picker rows are never used as a comparison baseline.

The design keeps both features in `Repository` and the existing overlays. A separate client and capability-session design was considered, but it duplicated mutation coordination and required changes to startup and existing callers. The chosen design retains its useful constraints: fixed-operation evolution reads, explicit absorb no-op feedback, and working-copy selection when the source disappears. Absorb uses textual patches because its main effect is distributing edits, while ancestry usually stays the same. Patches are buffered and history pagination refetches a larger prefix, matching the existing operation browser.

`navigationRevisions(revset)` reads uncapped metadata with `--ignore-working-copy --at-op=@`. Search matches descriptions and structured local and remote bookmark names case-insensitively, and IDs by prefix. Search request counters prevent superseded queries from replacing the view. Temporary navigation uses `snapshot(revset, true)` with the same read-only flags. Explicit refresh retains its existing working-copy snapshot behavior.

`snapshot(revset)` reads graph-prefixed JSON metadata and a marked description row from one `jj log` command. The adapter retains jj's graph prefixes and connector rows. Word wrapping is disabled for the metadata protocol. Each node and description row references its parsed revision.

`RevisionLog` displays the graph in a scrollable pane, highlights a selected revision's two rows, and skips connectors during keyboard navigation. Lines truncate to the available width instead of wrapping and breaking the graph. The app owns selection, focus, inputs, menus, and confirmations. Prompt variants distinguish browsing, text entry, selection, confirmation, and a history-editing form. A selected action captures its source before opening subsequent pickers.

`PreviewSession` owns request replacement, stale successes and failures, and disposal. The main pane and overlay share one session: changing the active preview invalidates work for either pane, matching the existing interaction. Rendering stays in `ChangePreview`. `MutationReview` serializes writes through refresh; the app separately excludes overlapping menu and loading work.

`TreeComparisonView` renders captured before/after graph text in equal-width columns inside the shared preview scroller. Graph lines do not wrap; long labels are clipped. Both confirmation dialogs and history forms use this view.

`ActionOverlay` supplies the shared dialog layout: source context, fields, local feedback, preview, and keyboard hints. Quick inputs use a smaller height. The background graph stays visible and its mouse selection is disabled until the overlay closes.

`HistoryForm` owns rebase and squash drafts. Destination, scope or files, description, and Apply remain in one form. Editing a field returns to that form. Both the form and ordinary confirmations use the same `MutationReview` instance. The review module owns prepared-operation validity, ignores superseded preparation results, and requires fresh preparation after failure. Confirmation prompts retain the selected action for editing but do not hold a second prepared operation. Failed operations preserve the draft and require a refreshed preview. Quick-input failures return to the editable input with its value intact. Success closes the overlay and shows a short result message above the graph.

After a successful write, `MutationReview` returns an applied result even if refresh fails. Both interaction paths close their overlay and report that the operation succeeded, directing the user to refresh instead of repeating the action. Working-copy-changing actions reset the filter to `all()` and select the working copy. Other actions preserve the active revset and recover selection by commit ID, then a unique change ID.

## Source organization

| Directory or file | Ownership |
| --- | --- |
| `src/app.ts` | Navigation, focus, selection recovery, and connecting modules |
| `src/history/` | Mutation review, editable history forms, and tree comparison |
| `src/preview/` | Preview request lifetime and text or diff rendering |
| `src/revisions/` | Revision graph rendering, selection, and dragging |
| `src/repository/` | Repository operations and their internal jj implementation |
| `src/ui/` | Shared overlays, highlighting, themes, and theme preferences |
| `src/terminal-text.ts` | Terminal-control filtering shared by command output and rendering |

Tests follow these directories. `tests/app.test.ts` retains complete user workflows; `tests/ui-tooling.test.ts` and `tooling/` retain scenario recording and styled snapshots. Lifecycle tests use delayed adapters for deterministic ordering and disposable jj repositories for actual writes.

Run `bun run check:architecture` to verify that imports resolve, the source graph has no cycles, and callers only import the repository's entry point or domain model. Run `rg --files src tests | sort` to list the current tree.

## Current limits

Initial revision graphs load 200 revisions and expand with `Ctrl+L` (`L` in the `legacy` keybinding preset). Destination pickers use uncapped metadata and share the `RevisionSearch` controller for filtering and keyboard handling. Search reads the entire active revset without that limit and buffers revision metadata in memory. Navigation reveals a target with up to 39 immediate relatives, preserving the original graph and scroll position for return. Operation history and change evolution start with 50 entries and can load more. Automatic refresh polls `jj status` and the operation ID every two seconds while browsing. It reads replacement views before applying them, checks the operation ID again, and discards results after intervening user activity. Updates preserve selection, searches, scroll positions, and temporary return views. Prompts, actions, external tools, and drags defer checks; disposal clears the timer. Diffs are buffered in memory. Descriptions use a scrolling OpenTUI text area with Shift/Alt+Enter for newlines and Enter to save; other quick inputs are single-line. Describe also supports JJ’s configured external editor, and conflicted revisions can launch JJ’s merge tool. Both use the interactive command target validation and foreground lifecycle, then refresh the current revset and retain selection. Squash can preserve an existing multiline description without flattening it. Split can edit the second description or preserve its original multiline text.

Destination search covers the full history. Conflict resolution uses JJ’s configured external merge tool.

## Verification

Verified on macOS with Bun 1.4.2 and jj 0.45.1:

- `bun run typecheck` and `bun run check:architecture` pass.
- `bun test` passes, including renderer snapshots.
- Repository tests verify bookmark targets, edit/abandon behavior, operation inspection without writes, undo/restore, and rebase parent relationships in both move modes.
- File-level split and squash tests compare the final repository contents with the original. Literal filenames include spaces and wildcard characters. Partial squash verifies that unselected files remain in the source.
- Graph tests compare branches, merges, filtered ancestry, and empty results with native jj output. Renderer tests verify commit selection, narrow layout, and scrolling through long graphs.
- Tests cover rebase-created conflicts, immutable targets, external operations and file edits invalidating confirmations, and stale asynchronous diffs.
- Absorb tests verify two recipients, source leftovers, source abandonment, immutable ancestors, no-op results, and stale selections. Evolution tests cover description and content rewrites, combined predecessors, fixed-operation pagination, user word wrapping, and unsnapshotted edits. Renderer tests keep operation notes visible after diffs and reject outdated evolution previews.
- Overlay tests cover 80-column input placement, graph visibility, correcting duplicate bookmark names, and preserving rebase fields after stale-confirmation failures.
- Keyboard tests drive bookmark creation/rename/undo, operation history, cancellation, stale confirmation, and a complete split-then-squash flow through the actual OpenTUI renderer.
- `bun run demo` starts in a real PTY. The action menu renders and Ctrl-C restores the terminal and exits successfully.

Tests create disposable repositories and never initialize the source checkout as a jj workspace.

### Configurable browse keys

`ui/keybindings.ts` defines the browse action map, strict JSON configuration loader,
key-event matching, and display labels. Startup loads the optional XDG
`jj-evolved/keybindings.json` before creating the renderer. Configuration errors
identify the file and conflicting actions. Browse routing resolves one action
only after modal and text-input handling; Ctrl-C remains an emergency exit.
Tests cover parsing, collisions, terminal aliases, missing and invalid files,
and renderer behavior through the injected `keybindings` UI scenario.

## Terminal focus refresh

The app subscribes to the renderer's terminal `focus` event. Focus requests are coalesced and deferred while a prompt, operation, or repository load is active. Existing external-tool and mutation refreshes consume requests already queued, avoiding a duplicate reload on resume. A focus event during an ongoing read queues one follow-up read. Returning focus invalidates prepared reviews without changing the action draft; `p` prepares a fresh review.

Automatic refresh retains the active revset, selected commit (falling back to a unique change ID after rewrites), graph scroll, preview scroll, and accepted search query with recalculated matches. It reloads an open working-copy status view and keeps keyboard help visible. Temporary navigation views retain their selection and return path by deferring refresh until Ctrl-O, with a visible notice. No filesystem watcher is installed; `r` remains the fallback for terminals that do not report focus. Stop removes the focus listener, and late reads cannot update a disposed app.

The `automatic-refresh` UI scenario captures external CLI changes appearing on focus return and an open draft waiting for refresh. Renderer integration tests exercise external descriptions and files, retained filters and drafts, review invalidation, event coalescing, temporary navigation, help, and disposal.


### Expanded history and destination search

The graph initially loads 200 revisions; `L` increases the limit by 200 and rerenders JJ's native graph for that complete window. Keeping the native graph intact avoids splicing branch/merge lanes from separate pages. A bounded metadata probe reports whether older results remain. Expansion preserves selection, scroll, and accepted search markers; it discards a result if the view changed while loading. Normal refresh retains the expanded limit, while changing revsets resets it. Temporary ancestry/search context views retain their existing return point and require returning before expansion.

Rebase/squash form destinations, interactive squash, and bookmark destinations read uncapped revision metadata, then filter locally by case-insensitive description, bookmark text, or change/commit ID. The source commit is excluded where appropriate. `/` enters search, arrows navigate results, Enter selects, and Escape clears the filter. Empty results cannot trigger an action. Inline rebase/squash expose the same picker with `/`.

`bun run ui record large-history` records a 205-revision fixture, destination search beyond the first page, a cancelled preview, and an expanded graph. Repository and renderer tests exercise the page boundary, search cancellation/source exclusion, and selection changes during an in-flight expansion.

## Remote workflows

Remote actions use the existing mutation-review lifecycle. Push previews run `jj git push --bookmark exact:<name> --dry-run` at the captured operation, without publishing or changing tracking state. Apply checks the operation and remote URL, then pins that same operation so concurrent local edits cannot substitute different push targets. JJ checks remote leases at push time. Deleted tracked bookmarks remain selectable for explicit deletion reviews; conflicted bookmarks are rejected. Fetch and tracking changes are reviewed, and tracking status appears in the bookmark browser. Git's synthetic `@git` bookmark is informational.

Network failures preserve JJ diagnostics and offer authentication, rejected-push, and interrupted-connection recovery instructions. Interactive Git credential prompting is disabled. Operations share the existing 30-second timeout. Remote configuration is currently managed through the JJ CLI. Repository tests use disposable local bare Git remotes to verify preview purity, exact push scope, deletion, tracking, stale local state, changed remote URLs, concurrent remote updates, and inaccessible remotes. The `remotes` UI scenario records remote selection, push review/cancellation, and tracking review/application.

### External description editing

The Space menu exposes **Describe in editor**, while `d` opens the in-app multiline editor. `Repository.editDescription` snapshots pending working-copy changes and rejects a stale selected commit before running `jj describe --editor <commit-id>` in the foreground. JJ owns editor configuration, description parsing, and the single description rewrite operation. The renderer suspends while the editor runs and resumes on success or failure. Refresh preserves the active revset and recovers the selected revision by its stable change ID. Editors that exit successfully without changes leave the description unchanged; nonzero exits report failure without applying the draft.

Repository and renderer tests launch a real configured fake editor to verify multiline and Unicode preservation, unchanged exit, failed exit, stale selection rejection, selection/filter retention, and keyboard recovery. The `multiline-description` UI scenario records the action menu and saved multiline result.
