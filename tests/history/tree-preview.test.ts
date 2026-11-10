import { expect, test } from "bun:test";
import { join } from "node:path";
import { RGBA } from "@opentui/core";
import { fixture } from "../fixture";
import { Repository } from "../../src/repository/repository";

const template = 'change_id.shortest(8) ++ " " ++ local_bookmarks.map(|b| "[" ++ b.name() ++ "]").join(" ") ++ if(conflict, " [conflict]") ++ "\\n" ++ coalesce(description.first_line(), "(no description)") ++ "\\n"';


for (const descendants of [false, true]) {
  test(`projected rebase tree matches jj after applying, descendants=${descendants}`, async () => {
    const f = await fixture();
    try {
      const repo = await Repository.open(f.path);
      const source = (await repo.snapshot("@")).revisions[0];
      await f.jj("new", "-m", "Child left behind or moved");
      await f.jj("new", "root()", "-m", "Destination");
      const destination = (await repo.snapshot("@")).revisions[0];
      if (!source || !destination) throw new Error("Missing revisions");
      const before = await repo.operationId();
      const snapshot = await repo.snapshot("all()");
      const beforeTree = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      const prepared = await repo.prepare({ kind: "rebase", revision: source, destination, descendants });
      expect(prepared.trees?.before.replaceAll("● ", "")).toBe(beforeTree);
      expect(await repo.operationId()).toBe(before);
      expect((await repo.snapshot("all()")).revisions).toEqual(snapshot.revisions);
      expect(prepared.trees?.after).toContain("Child left behind or moved");
      if (descendants) {
        expect(prepared.summary).toContain("Will rebase 2 changes");
        expect(prepared.trees?.before.match(/● /g)).toHaveLength(2);
        expect(prepared.trees?.after.match(/● /g)).toHaveLength(2);
        expect(prepared.trees?.after).toContain(`● ${source.changeId.slice(0, 8)}`);
        expect(prepared.trees?.after).not.toContain(`● ${destination.changeId.slice(0, 8)}`);
      } else {
        // Only the selected change moves, and both trees mark it.
        expect(prepared.trees?.before.match(/● /g)).toHaveLength(1);
        expect(prepared.trees?.after).toContain(`● ${source.changeId.slice(0, 8)}`);
      }
      expect(prepared.trees?.newConflicts).toBe(0);
      await repo.apply(prepared);
      const actual = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      expect(prepared.trees?.after.replaceAll("● ", "")).toBe(actual);
    } finally { await f.cleanup(); }
  });
}

test("rebase scope and its confirmation include descendants beyond the graph limit", async () => {
  const f = await fixture();
  try {
    const repo = await Repository.open(f.path);
    const source = (await repo.snapshot("feature")).revisions[0];
    const destination = (await repo.snapshot("root()")).revisions[0];
    if (!source || !destination) throw new Error("Missing source or destination");
    for (let index = 0; index < 201; index++) await f.jj("new", "-m", `Descendant ${index}`);
    const before = await repo.operationId();
    expect((await repo.snapshot("all()")).revisions).toHaveLength(200);
    const scope = await repo.rebaseScope(source);
    expect(scope).toHaveLength(203);
    expect(scope.some(revision => revision.commitId === source.commitId)).toBe(true);
    const prepared = await repo.prepare({ kind: "rebase", revision: source, destination, descendants: true });
    expect(prepared.summary).toContain("Will rebase 203 changes");
    expect(prepared.summary).toContain("Descendant 0\n");
    expect(prepared.summary).toContain("Descendant 200\n");
    expect(prepared.summary).toContain("Initial feature");
    expect(await repo.operationId()).toBe(before);
  } finally { await f.cleanup(); }
}, 30_000);

for (const partial of [false, true]) {
  test(`projected squash tree matches jj and preview preserves files, partial=${partial}`, async () => {
    const f = await fixture();
    try {
      const repo = await Repository.open(f.path);
      await Bun.write(`${f.path}/one.txt`, "one\n");
      await Bun.write(`${f.path}/two.txt`, "two\n");
      const source = (await repo.snapshot("@")).revisions[0];
      const destination = (await repo.snapshot("feature")).revisions[0];
      await f.jj("new", "-m", "Child of squashed change");
      if (!source || !destination) throw new Error("Missing revisions");
      const before = await repo.operationId();
      const snapshot = await repo.snapshot("all()");
      const beforeTree = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      const prepared = await repo.prepare({ kind: "squash", revision: source, destination, files: partial ? ["one.txt"] : [], description: "Combined" });
      // The source is marked ● in the trees; without the mark they are jj's own log.
      expect(prepared.trees?.before).toContain(`● ${source.changeId.slice(0, 8)}`);
      expect(prepared.trees?.before.replaceAll("● ", "")).toBe(beforeTree);
      expect(await repo.operationId()).toBe(before);
      expect((await repo.snapshot("all()")).revisions).toEqual(snapshot.revisions);
      expect(await Bun.file(`${f.path}/one.txt`).text()).toBe("one\n");
      expect(await Bun.file(`${f.path}/two.txt`).text()).toBe("two\n");
      expect(prepared.trees?.after?.includes(source.changeId.slice(0, 8))).toBe(partial);
      await repo.apply(prepared);
      const actual = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      expect(prepared.trees?.after.replaceAll("● ", "")).toBe(actual);
    } finally { await f.cleanup(); }
  });
}

test("an unchanged rebase still renders a tree without creating a live operation", async () => {
  const f = await fixture();
  try {
    const repo = await Repository.open(f.path);
    const source = (await repo.snapshot("@")).revisions[0];
    const destination = (await repo.snapshot("@-")).revisions[0];
    if (!source || !destination) throw new Error("Missing revisions");
    const before = await repo.operationId();
    const prepared = await repo.prepare({ kind: "rebase", revision: source, destination, descendants: false });
    expect(prepared.trees?.after.replaceAll("● ", "")).toBe(await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template));
    expect(await repo.operationId()).toBe(before);
  } finally { await f.cleanup(); }
});

test("popup trees and revision summaries render JJ token colors", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { RGBA } = await import("@opentui/core");
  const { TreeComparisonView } = await import("../../src/history/tree-comparison");
  const { ChangePreview } = await import("../../src/preview/change-preview");
  const { themes } = await import("../../src/ui/theme");
  const jjColors = themes.terminal;
  const screen = await createTestRenderer({ width: 120, height: 15 });
  const trees = new TreeComparisonView(screen.renderer, "popup-trees");
  const summary = new ChangePreview(screen.renderer, "popup-summary", "Source qwrtyuok / abcdef123456\nA description\nInto zzzzzzzz / 000000000000 Destination");
  summary.prefixes = new Map([["qwrtyuok", "qw"], ["zzzzzzzz", "z"]]);
  summary.content = summary.content;
  screen.renderer.root.add(trees);
  screen.renderer.root.add(summary);
  try {
    trees.setTrees({
      beforePrefixes: new Map([["qwrtyuok", "qw"], ["zzzzzzzz", "z"]]),
      afterPrefixes: new Map([["qwrtyuok", "qw"], ["zzzzzzzz", "z"]]),
      before: "@  qwrtyuok [feature] Description [conflict]\n◆  zzzzzzzz  Root\n",
      after: "@  qwrtyuok [feature] Description\n◆  zzzzzzzz  Root\n",
    });
    await screen.waitForVisualIdle();
    const spans = screen.captureSpans().lines.flatMap(line => line.spans);
    for (const [token, color] of [
      ["qw", jjColors.changeId], ["rtyuok", jjColors.muted], ["[feature]", jjColors.bookmark],
      ["@", jjColors.accent], ["◆", jjColors.commit],
      ["[conflict]", jjColors.conflict], ["abcdef123456", jjColors.commit],
    ] satisfies [string, InstanceType<typeof RGBA>][]) {
      const matches = spans.filter(span => token === "@" || token === "◆" ? span.text.includes(token) : span.text.trim() === token);
      if (!matches.length) throw new Error(`Missing token ${token}: ${screen.captureCharFrame()}`);
      for (const span of matches) expect(span.fg).toEqual(color);
    }
    expect(spans.filter(span => span.text.trim() === "qw")).toHaveLength(3);
    expect(screen.captureCharFrame()).toContain("Description");
    trees.setTrees(null);
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).not.toContain("[feature]");
  } finally {
    trees.destroyRecursively();
    summary.destroyRecursively();
    screen.renderer.destroy();
  }
});

test("rebase previews retain ancestry lines beside descriptions like the standard log", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { TreeComparisonView } = await import("../../src/history/tree-comparison");
  const f = await fixture();
  const screen = await createTestRenderer({ width: 120, height: 20 });
  const trees = new TreeComparisonView(screen.renderer, "ancestry-trees");
  screen.renderer.root.add(trees);
  try {
    const repo = await Repository.open(f.path);
    const snapshot = await repo.snapshot("all()");
    const source = snapshot.revisions.find(revision => revision.workingCopy);
    const destination = snapshot.revisions.find(revision => revision.commitId === source?.parents[0]);
    if (!source || !destination) throw new Error("Missing fixture revisions");
    const prepared = await repo.prepare({ kind: "rebase", revision: source, destination, descendants: false });
    if (!prepared.trees) throw new Error("Missing rebase preview");
    const description = snapshot.graph.find(row => row.kind === "description" && row.revision.commitId === source.commitId);
    if (!description || description.kind !== "description") throw new Error("Missing graph description");
    const expectedLine = description.prefix + source.description.split("\n")[0];
    expect(expectedLine).toContain("│");
    expect(prepared.trees.before.split("\n")).toContain(expectedLine);
    expect(prepared.trees.after.split("\n")).toContain(expectedLine);
    trees.setTrees(prepared.trees);
    await screen.waitForVisualIdle();
    const frame = screen.captureCharFrame().split("\n");
    for (const side of ["before", "after"]) {
      const text = trees.findDescendantById(`ancestry-trees-${side}`);
      if (!text) throw new Error("Missing tree text");
      expect(frame.some(line => line.slice(text.x, text.x + text.width).startsWith(expectedLine))).toBe(true);
    }
  } finally { trees.destroyRecursively(); screen.renderer.destroy(); await f.cleanup(); }
});

test("a rebase that conflicts counts the changes it newly conflicts, and one that resolves a conflict does not", async () => {
  const f = await fixture();
  try {
    const repo = await Repository.open(f.path);
    await Bun.write(join(f.path, "hello.txt"), "left\n");
    await f.jj("describe", "-m", "Left edit");
    await f.jj("new", "feature", "-m", "Right edit");
    await Bun.write(join(f.path, "hello.txt"), "right\n");
    await f.jj("new", "-m", "Above right");
    const [left] = (await repo.snapshot("description(exact:'Left edit\n')")).revisions;
    const [right] = (await repo.snapshot("description(exact:'Right edit\n')")).revisions;
    if (!left || !right) throw new Error("Missing revisions");
    // Right, and the change above it, conflict once Right sits on Left.
    const conflicting = await repo.prepare({ kind: "rebase", revision: right, destination: left, descendants: true });
    expect(conflicting.trees?.newConflicts).toBe(2);
    await repo.apply(conflicting);
    // A conflict that is already there and stays is not counted: moving the change above Right keeps both conflicted.
    const [above] = (await repo.snapshot("description(exact:'Above right\n')")).revisions;
    const [movedRight] = (await repo.snapshot("description(exact:'Right edit\n')")).revisions;
    if (!above || !movedRight) throw new Error("Missing revisions");
    await f.jj("new", movedRight.commitId, "-m", "Sibling");
    const [sibling] = (await repo.snapshot("description(exact:'Sibling\n')")).revisions;
    expect((await repo.prepare({ kind: "rebase", revision: above, destination: sibling!, descendants: false })).trees?.newConflicts).toBe(0);
    // Moving Right back resolves both and creates none.
    const [moved] = (await repo.snapshot("description(exact:'Right edit\n')")).revisions;
    const [feature] = (await repo.snapshot("feature")).revisions;
    if (!moved || !feature) throw new Error("Missing revisions");
    expect((await repo.prepare({ kind: "rebase", revision: moved, destination: feature, descendants: true })).trees?.newConflicts).toBe(0);
  } finally { await f.cleanup(); }
});

test("preview trees colour moved rows, both lines, and head the trees with the conflicts the result creates", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { TreeComparisonView } = await import("../../src/history/tree-comparison");
  const { themes, setTheme } = await import("../../src/ui/theme");
  const screen = await createTestRenderer({ width: 120, height: 15 });
  setTheme(screen.renderer, themes.dark);
  const trees = new TreeComparisonView(screen.renderer, "moved-trees");
  screen.renderer.root.add(trees);
  const prefixes = new Map([["qwrtyuok", "qw"], ["xvtltxry", "x"], ["zzzzzzzz", "z"]]);
  const spanOf = (text: string) => screen.captureSpans().lines.flatMap(line => line.spans).filter(span => span.text.includes(text));
  try {
    trees.setTrees({
      beforePrefixes: prefixes, afterPrefixes: prefixes,
      before: "@  ● qwrtyuok [feature]\n│  Moved change\n○  xvtltxry\n│  Stays put\n◆  zzzzzzzz\n   Root\n",
      after: "×  ● qwrtyuok [feature] [conflict]\n│  Moved change\n○  xvtltxry\n│  Stays put\n◆  zzzzzzzz\n   Root\n",
      newConflicts: 1,
    }, "rebase");
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).toContain("! Creates conflicts in 1 change");
    // The headline takes a row of its own, so the trees keep their last row.
    expect(screen.captureCharFrame()).toContain("Root");
    for (const span of [...spanOf("Moved change"), ...spanOf("●")]) expect(span.fg).toEqual(RGBA.fromHex(themes.dark.accent));
    for (const span of spanOf("Stays put")) expect(span.fg).toEqual(RGBA.fromHex(themes.dark.text));
    // A summary line also starts "● <change>", but names the commit after " / " and has no description line below.
    const { highlightJjText } = await import("../../src/ui/jj-highlighting");
    const summary = highlightJjText("● qwrtyuok / abcdef123456 Moved change\nTrees show up to 40 revisions", prefixes, themes.dark);
    expect(summary.chunks.find(chunk => chunk.text.includes("Trees show"))?.fg).toEqual(RGBA.fromHex(themes.dark.text));
    trees.setTrees({ beforePrefixes: prefixes, afterPrefixes: prefixes, before: "@  qwrtyuok\n", after: "@  qwrtyuok\n", newConflicts: 0 });
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame()).not.toContain("Creates");
  } finally {
    trees.destroyRecursively();
    screen.renderer.destroy();
  }
});
