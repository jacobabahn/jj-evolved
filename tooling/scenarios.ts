import { parseKeybindings, type Keybindings } from "../src/ui/keybindings";
import { strict as assert } from "node:assert";
import { descriptionEditor } from "../tests/description-editor";
import type { UiFixture } from "./ui";

type Scenario = { bindings?: Keybindings; name: string; title: string; run: (ui: UiFixture) => Promise<void> };

export const scenarios: Scenario[] = [
  {
    name: "keybindings", title: "Custom browse keys and unchanged text input",
    bindings: parseKeybindings({ bindings: { down: ["x", "down"], help: ["h"], describe: ["D"], togglePreview: ["P"] } }),
    async run(ui) {
      ui.key("P");
      assert.equal(ui.screen.renderer.root.findDescendantById("preview")?.visible, false);
      ui.key("p");
      assert.equal(ui.screen.renderer.root.findDescendantById("preview")?.visible, false);
      ui.key("h");
      await ui.until("Keyboard reference");
      assert.equal(ui.node("preview").visible, true);
      assert(ui.screen.captureCharFrame().includes("x/down / k/up"));
      await ui.capture("Custom movement and describe shortcuts in help");
      ui.key("j");
      await ui.until("Keyboard reference");
      ui.key("x");
      await ui.until("+ hello from jj-evolved");
      await ui.capture("Remapped x selects the parent change");
      ui.key("D");
      await ui.until("Describe");
      ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
      await ui.type("xhD stay text in prompts");
      await ui.capture("Browse shortcuts remain text in the description prompt");
      ui.key("RETURN");
      await ui.until("Ready.");
      assert.equal((await ui.repo.snapshot("@-")).revisions[0]?.description.trim(), "xhD stay text in prompts");
    },
  },
  {
    name: "automatic-refresh", title: "External changes refresh when terminal focus returns",
    async run(ui) {
      ui.key("/");
      await ui.prompt("@ | feature");
      ui.key("j");
      await ui.until("+ hello from jj-evolved");
      await ui.capture("Before returning from external CLI work");
      await ui.f.jj("describe", "-r", "feature", "-m", "Description edited in another terminal");
      await ui.f.jj("bookmark", "create", "external-review", "-r", "feature");
      ui.screen.renderer.emit("focus");
      await ui.until("Description edited in another terminal");
      await ui.until("Ready.");
      assert(ui.screen.captureCharFrame().includes("revset: @ | feature"));
      await ui.capture("Focus return updates history and preserves selection and filter");
      ui.key("d");
      await ui.type(" draft");
      ui.screen.renderer.emit("focus");
      await ui.until("refresh pending");
      await ui.capture("Open description draft is preserved while refresh waits");
      ui.key("ESCAPE");
      await ui.until("Ready.");
    },
  },
  {
    name: "large-history", title: "Search destinations and load history beyond 200 revisions",
    bindings: parseKeybindings({ bindings: { loadMore: ["x"] } }),
    async run(ui) {
      for (let i = 0; i < 202; i++) await ui.f.jj("new", "-m", `History change ${i + 1}`);
      ui.key("r");
      await ui.until("x load 200 more");
      await ui.until("Ready.");
      await ui.capture("First 200 revisions with load more available");
      const first = await ui.repo.snapshot("all()", true);
      assert.equal(first.revisions.length, 200);
      assert(first.hasMore);
      assert(!first.revisions.some(revision => revision.description.includes("Initial feature")));
      const before = await ui.repo.operationId();
      ui.key(" "); ui.choose("Rebase change");
      await ui.until("Destination: Choose a revision");
      ui.key("RETURN");
      await ui.until("/ search all destinations");
      ui.key("/"); await ui.type("Initial feature");
      await ui.until("1 destinations");
      await ui.capture("Destination search reaches beyond the graph page");
      ui.key("RETURN");
      await ui.until("Preview ready");
      await ui.capture("Older destination selected and previewed");
      ui.key("ESCAPE");
      await ui.until("Working copy");
      ui.key("L");
      await ui.screen.renderOnce();
      assert(ui.screen.captureCharFrame().includes("200 revisions"));
      ui.key("x");
      await ui.until("205 revisions");
      await ui.until("Ready.");
      await ui.capture("Expanded graph retains the selected revision");
      assert.equal(await ui.repo.operationId(), before);
      const expanded = await ui.repo.snapshot("all()", true, 400);
      assert.equal(expanded.revisions.length, 205);
      assert.equal(expanded.hasMore, false);
      await ui.f.jj("bookmark", "create", "expanded-refresh");
      await ui.app.checkForUpdates();
      await ui.until("205 revisions");
      assert(expanded.revisions.some(revision => revision.description.includes("Initial feature")));
    },
  },
  {
    name: "remotes", title: "Review a push and manage remote bookmark tracking",
    async run(ui) {
      const remote = `${ui.f.path}/.jj/demo-remote.git`;
      const git = Bun.spawn(["git", "init", "--bare", remote], { stdout: "ignore", stderr: "pipe" });
      assert.equal(await git.exited, 0);
      await ui.f.jj("git", "remote", "add", "origin", remote);
      ui.key("b");
      await ui.until("Git remotes");
      ui.choose("Git remotes");
      await ui.until("origin");
      ui.choose("origin");
      await ui.until("Push bookmark");
      await ui.capture("Choose fetch or push for a named remote");
      ui.choose("Push bookmark");
      await ui.until("Review before publishing");
      ui.choose("feature");
      await ui.until("Push only bookmark: feature");
      await ui.capture("Review exact bookmark targets before publishing");
      const before = await ui.repo.operationId();
      ui.key("ESCAPE");
      await ui.until("Empty change.");
      assert.equal(await ui.repo.operationId(), before);
      await ui.repo.apply(await ui.repo.prepare({ kind: "git-push", remote: "origin", name: "feature" }));
      ui.key("b");
      await ui.until("feature@origin");
      await ui.capture("Local and tracked remote bookmarks");
      ui.choose("feature@origin");
      await ui.until("Untrack bookmark");
      ui.choose("Untrack bookmark");
      await ui.until("Untrack feature@origin");
      await ui.capture("Review remote bookmark tracking change");
      ui.key("RETURN");
      await ui.until("Bookmark untrack completed");
      assert.equal((await ui.repo.bookmarks()).find(bookmark => bookmark.remote === "origin")?.tracked, false);
    },
  },
  {
    name: "completion", title: "Revset bookmark completion",
    async run(ui) {
      await ui.resize(80, 24);
      ui.key("/");
      ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
      await ui.type("ancestors(fea");
      await ui.until("feature@git");
      await ui.capture("Revset suggestions at 80x24");
      ui.key("TAB");
      await ui.type(")");
      ui.key("RETURN");
      await ui.until("revset: ancestors(feature)");
      await ui.until("Ready.");
      await ui.capture("Completed expression applied");
    },
  },
  {
    name: "multiline-description", title: "Edit a multiline description in the configured editor",
    async run(ui) {
      const description = "Explain the feature\n\nKeep context and implementation details together.\nPreserve Unicode: café 日本語.\n";
      const editor = await descriptionEditor(ui.f, description);
      try {
        ui.key(" ");
        await ui.until("Edit description in editor");
        await ui.capture("Edit the full description from the action menu");
        ui.choose("Edit description in editor");
        await ui.until("Ready.");
        assert.equal((await ui.repo.snapshot("@")).revisions[0]?.description, description);
        await ui.until("Keep context and implementation details together.");
        await ui.capture("Saved multiline description after returning from the editor");
      } finally { await editor.cleanup(); }
    },
  },
  {
    name: "browse", title: "Browse, diff, and narrow help",
    async run(ui) {
      await ui.until("Empty change.");
      await ui.capture("Working-copy selection");
      ui.key("j");
      await ui.until("+ hello from jj-evolved");
      await ui.capture("Selected change and diff");
      ui.key("?");
      await ui.until("Keyboard reference");
      await ui.capture("Keyboard help");
      await ui.resize(80, 24);
      await ui.until("Keyboard reference");
      await ui.capture("Help at 80x24");
      await ui.scroll("preview", "down");
      await ui.capture("Scroll the narrow help pane");
    },
  },
  {
    name: "rebase", title: "Rebase preview and cancellation",
    async run(ui) {
      const before = await ui.repo.operationId();
      ui.key("R");
      await ui.until("Rebase from ●");
      ui.key("j"); ui.key("j");
      ui.key("RETURN");
      await ui.until("Confirm operation");
      await ui.until("Current tree");
      await ui.until("After rebase");
      await ui.capture("Review proposed and current trees");
      assert.equal(await ui.repo.operationId(), before);
      await ui.resize(80, 24);
      await ui.capture("Preview at 80x24");
      const left = ui.node("confirmation-trees-after"), right = ui.node("confirmation-trees-before");
      assert(left.screenX < right.screenX);
      assert.equal(left.screenY, right.screenY);
      ui.key("ESCAPE");
      await ui.until("Enter preview");
      ui.key("ESCAPE");
      await ui.until("Cancelled.");
      await ui.capture("Cancelled without changing the repository");
      assert.equal(await ui.repo.operationId(), before);
    },
  },
  {
    name: "states", title: "Empty history and an editable error",
    async run(ui) {
      ui.key("/");
      await ui.prompt("none()");
      await ui.until("No revisions match");
      await ui.capture("Empty revset");
      ui.key("/");
      await ui.prompt("all()");
      await ui.until("3 revisions");
      ui.key(" ");
      ui.choose("Create bookmark");
      await ui.until("Bookmark name");
      await ui.type("feature");
      ui.key("RETURN");
      await ui.until("Confirm operation");
      ui.key("RETURN");
      await ui.until("already exists");
      await ui.capture("Duplicate bookmark error retains the input");
      assert(ui.node("prompt-input").focused);
      ui.key("ESCAPE");
    },
  },
  {
    name: "bookmarks", title: "Drag a bookmark and cancel the preview",
    async run(ui) {
      const snapshot = await ui.repo.snapshot("all()");
      const bookmarks = await ui.repo.bookmarks();
      const source = bookmarks.find(bookmark => bookmark.name === "feature" && !bookmark.remote);
      assert(source);
      const row = snapshot.graph.findIndex(row => row.kind === "revision" && source.targets.includes(row.revision.commitId));
      const sourceRow = snapshot.graph[row];
      assert(sourceRow?.kind === "revision");
      const badge = bookmarks.filter(bookmark => bookmark.targets.includes(sourceRow.revision.commitId))
        .findIndex(bookmark => bookmark.name === "feature" && !bookmark.remote);
      const target = snapshot.graph.findIndex(row => row.kind === "revision" && row.revision.workingCopy);
      const before = await ui.repo.operationId();
      await ui.drag(`bookmark-${row}-${badge}`, `revision-row-${target}`);
      await ui.until("Confirm operation");
      await ui.capture("Bookmark move preview");
      assert.equal(await ui.repo.operationId(), before);
      ui.key("ESCAPE");
      await ui.capture("Cancelled bookmark move");
      assert.deepEqual(await ui.repo.bookmarks(), bookmarks);
    },
  },
  {
    name: "themes", title: "Live theme preview",
    async run(ui) {
      ui.key("t");
      await ui.until("Previewing Dark");
      await ui.capture("Dark theme dialog");
      ui.key("j");
      await ui.until("Previewing Light");
      await ui.capture("Light theme dialog");
      ui.key("j");
      await ui.until("Previewing Gruvbox Dark");
      await ui.capture("Gruvbox theme dialog");
      ui.key("ESCAPE");
      await ui.capture("Restored the original theme");
    },
  },
  {
    name: "unicode", title: "Unicode description via bracketed paste",
    async run(ui) {
      const description = "日本語 café 👩‍💻";
      ui.key("d");
      await ui.until("Describe");
      ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
      await ui.paste(description);
      await ui.capture("Pasted Unicode description");
      ui.key("RETURN");
      await ui.until("Ready.");
      assert.equal((await ui.repo.snapshot("@")).revisions[0]?.description.trim(), description);
      await ui.capture("Saved Unicode description");
    },
  },
  {
    name: "review-retry", title: "Stale rebase review, refresh, and apply",
    async run(ui) {
      const source = (await ui.repo.snapshot("@")).revisions[0];
      assert(source);
      ui.key(" ");
      ui.choose("Rebase change");
      await ui.until("Destination: Choose a revision");
      ui.key("RETURN");
      await ui.until("j/k choose");
      ui.key("j");
      ui.key("RETURN");
      await ui.until("Preview ready");
      await ui.capture("Form has a reviewed rebase onto root");
      await ui.f.jj("bookmark", "create", "external-operation");
      const external = await ui.repo.operationId();
      ui.key("j"); ui.key("j");
      ui.key("RETURN");
      await ui.until("Repository changed");
      await ui.capture("Stale review rejected; destination and draft retained");
      assert.equal(await ui.repo.operationId(), external);
      assert.deepEqual((await ui.repo.snapshot(source.changeId)).revisions[0]?.parents, source.parents);
      assert(ui.screen.captureCharFrame().includes("Destination: zzzzzzzz"));
      ui.key("p");
      await ui.until("Preview ready");
      await ui.capture("Refreshed review is ready to apply");
      ui.key("RETURN");
      await ui.until("rebase completed");
      assert.deepEqual((await ui.repo.snapshot(source.changeId)).revisions[0]?.parents, ["0".repeat(40)]);
      assert.equal(ui.screen.renderer.root.findDescendantById("history-form"), undefined);
      await ui.capture("Rebase applied once and form closed");
    },
  },
  {
    name: "preview-race", title: "Late diff success and failure cannot replace the selection",
    async run(ui) {
      const originalDiff = ui.repo.diff.bind(ui.repo);
      for (const outcome of ["success", "failure"] as const) {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        let delay = true;
        ui.repo.diff = async (revision, files) => {
          if (!delay) return originalDiff(revision, files);
          delay = false;
          started.resolve();
          try {
            await release.promise;
            if (outcome === "failure") throw new Error("Obsolete diff failure");
            return await originalDiff(revision, files);
          } finally { finished.resolve(); }
        };
        try {
          ui.key("j");
          await started.promise;
          await ui.until("Loading diff…");
          await ui.capture(`Older diff pending before ${outcome}`);
          ui.key("k");
          await ui.until("Empty change.");
          await ui.capture("New selection displayed before older request settles");
          release.resolve();
          await finished.promise;
          await ui.capture(`Late ${outcome} leaves the new selection intact`);
          const frame = ui.screen.captureCharFrame();
          assert(frame.includes("Empty change."));
          assert(!frame.includes("+ hello from jj-evolved"));
          assert(!frame.includes("Obsolete diff failure"));
        } finally {
          release.resolve();
          ui.repo.diff = originalDiff;
        }
      }
    },
  },
];
