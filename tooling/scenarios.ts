import { strict as assert } from "node:assert";
import type { UiFixture } from "./ui";

type Scenario = { name: string; title: string; run: (ui: UiFixture) => Promise<void> };

export const scenarios: Scenario[] = [
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
];
