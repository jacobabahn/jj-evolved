import { expect, test } from "bun:test";
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
      expect(prepared.trees?.before).toBe(beforeTree);
      expect(await repo.operationId()).toBe(before);
      expect((await repo.snapshot("all()")).revisions).toEqual(snapshot.revisions);
      expect(prepared.trees?.after).toContain("Child left behind or moved");
      await repo.apply(prepared);
      const actual = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      expect(prepared.trees?.after).toBe(actual);
    } finally { await f.cleanup(); }
  });
}

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
      expect(prepared.trees?.before).toBe(beforeTree);
      expect(await repo.operationId()).toBe(before);
      expect((await repo.snapshot("all()")).revisions).toEqual(snapshot.revisions);
      expect(await Bun.file(`${f.path}/one.txt`).text()).toBe("one\n");
      expect(await Bun.file(`${f.path}/two.txt`).text()).toBe("two\n");
      expect(prepared.trees?.after?.includes(source.changeId.slice(0, 8))).toBe(partial);
      await repo.apply(prepared);
      const actual = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      expect(prepared.trees?.after).toBe(actual);
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
    expect(prepared.trees?.after).toBe(await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template));
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
