import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Repository } from "../../src/repository/repository";
import { createApp } from "../../src/app";
import { fixture } from "../fixture";
import { RevisionLog } from "../../src/revisions/revision-log";
import type { GraphRow, Revision, Snapshot } from "../../src/repository/model";
import type { TextRenderable } from "@opentui/core";

async function branchingFixture() {
  const f = await fixture();
  try {
    await f.jj("describe", "-m", "Left branch");
    await f.jj("new", "@-", "-m", "Right branch");
    await f.jj("new", "heads(all() ~ root())", "-m", "Merge branches");
    return f;
  } catch (error) { await f.cleanup(); throw error; }
}

test("graph prefixes match jj for merges, branches, filtered ancestry and an empty revset", async () => {
  const f = await branchingFixture();
  try {
    const repository = await Repository.open(f.path);
    for (const revset of ["all()", "@ | root()", "@", "none()"]) {
      const snapshot = await repository.snapshot(revset);
      const reconstructed = snapshot.graph.map(row => row.kind === "edge" ? row.text : row.prefix + (
        row.kind === "revision" ? row.revision.commitId : "::description::"
      )).join("\n");
      const native = await f.jj("log", "-r", revset, "--limit", "200", "--config", "ui.log-word-wrap=false", "-T", "commit_id ++ '\n::description::\n'");
      expect(reconstructed).toBe(native.trimEnd());
      expect(snapshot.graph.filter(row => row.kind === "revision")).toHaveLength(snapshot.revisions.length);
      expect(snapshot.graph.filter(row => row.kind === "description")).toHaveLength(snapshot.revisions.length);
    }
    const filtered = await repository.snapshot("@ | root()");
    expect(filtered.graph.some(row => row.kind === "edge" && row.text.includes("elided revisions"))).toBe(true);
  } finally { await f.cleanup(); }
});

test("renderer draws the native graph and navigation selects commits rather than connector rows", async () => {
  const f = await branchingFixture();
  const screen = await createTestRenderer({ width: 100, height: 30 });
  const repository = await Repository.open(f.path);
  const app = createApp(screen.renderer, repository);
  try {
    const snapshot = await repository.snapshot("all()");
    await app.start();
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    for (const row of snapshot.graph) {
      if (row.kind === "description" && row.prefix.trim()) expect(frame).toContain(row.prefix.trim());
    }
    expect(frame).toContain("Merge branches");
    expect(frame).toContain("Left branch");
    expect(frame).toContain("Right branch");
    for (const [index, revision] of snapshot.revisions.entries()) {
      if (index) screen.mockInput.pressKey("j");
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain(revision.commitId);
    }
    screen.resize(80, 24);
    screen.mockInput.pressKey("k");
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("Revisions");
    expect(screen.captureCharFrame()).toContain("q quit");
  } finally { app.stop(); screen.renderer.destroy(); await f.cleanup(); }
});

test("selected revisions remain visible while scrolling through a long graph", async () => {
  const f = await fixture();
  const screen = await createTestRenderer({ width: 100, height: 16 });
  const repository = await Repository.open(f.path);
  const app = createApp(screen.renderer, repository);
  try {
    for (let index = 0; index < 12; index++) await f.jj("new", "-m", `Change ${index}`);
    const snapshot = await repository.snapshot("all()");
    await app.start();
    await screen.renderOnce();
    for (let index = 0; index < snapshot.revisions.length - 1; index++) screen.mockInput.pressKey("j");
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("▶ ◆  zzzzzzzz");
    for (let index = 0; index < snapshot.revisions.length - 1; index++) screen.mockInput.pressKey("k");
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("▶ @");
  } finally { app.stop(); screen.renderer.destroy(); await f.cleanup(); }
});

test("JJ markings retain distinct colors when selected and marked as an action source", async () => {
  const { RevisionLog } = await import("../../src/revisions/revision-log");
  const screen = await createTestRenderer({ width: 90, height: 10 });
  const log = new RevisionLog(screen.renderer);
  screen.renderer.root.add(log);
  const revision = {
    changeId: "qwertyui", changePrefix: "qw", commitId: "a".repeat(40), description: "A conflicted change",
    author: "Test User", bookmarks: "feature", parents: [], workingCopy: true, conflict: true,
  };
  try {
    log.setSnapshot({ root: "/test", revisions: [revision], graph: [
      { kind: "revision", revision, prefix: "@  " },
      { kind: "description", revision, prefix: "│  " },
    ] }, [{ name: "feature", remote: "", conflict: false, targets: [revision.commitId] }]);
    for (const source of [null, 0]) {
      log.markSource(source);
      await screen.waitForVisualIdle();
      const spans = screen.captureSpans().lines.flatMap(line => line.spans);
      const token = (text: string) => {
        const span = spans.find(span => span.text.trim() === text);
        if (!span) throw new Error(`Missing token ${text}: ${screen.captureCharFrame()}`);
        return span;
      };
      const id = token("qw");
      expect(token("ertyui").fg).not.toEqual(id.fg);
      expect(token("ertyui").attributes).not.toBe(id.attributes);
      const bookmark = token("[feature]");
      const conflict = token("! conflict");
      const workingCopy = token("@");
      expect(id.fg).not.toEqual(bookmark.fg);
      expect(conflict.fg).not.toEqual(id.fg);
      expect(workingCopy.fg).not.toEqual(id.fg);
      expect(token("│").fg).not.toEqual(workingCopy.fg);
      expect(id.bg).toEqual(bookmark.bg);
      expect(screen.captureCharFrame()).toContain(source === null ? "▶ @" : "● @");
    }
  } finally { log.destroyRecursively(); screen.renderer.destroy(); }
});

test("rebase drag highlights the source change ID until cancelled", async () => {
  const { RevisionLog } = await import("../../src/revisions/revision-log");
  const screen = await createTestRenderer({ width: 90, height: 10 });
  const log = new RevisionLog(screen.renderer);
  screen.renderer.root.add(log);
  const source = {
    changeId: "qwertyui", changePrefix: "qw", commitId: "a".repeat(40), description: "Source",
    author: "Test User", bookmarks: "feature", parents: [], workingCopy: false, conflict: false,
  };
  const destination = { ...source, changeId: "rtyuiopq", changePrefix: "rt", commitId: "b".repeat(40), bookmarks: "" };
  try {
    log.setSnapshot({ root: "/test", revisions: [source, destination], graph: [
      { kind: "revision", revision: source, prefix: "○  " },
      { kind: "revision", revision: destination, prefix: "○  " },
    ] }, [{ name: "feature", remote: "", conflict: false, targets: [source.commitId] }]);
    log.canDrag = () => true;
    screen.renderer.root.onMouse = event => log.handleDragMouse(event);
    await screen.waitForVisualIdle();
    const label = screen.renderer.root.findDescendantById("revision-label-0");
    const target = screen.renderer.root.findDescendantById("revision-label-1");
    if (!label || !target) throw new Error("Missing revision labels");
    const spans = () => screen.captureSpans().lines.flatMap(line => line.spans);
    const original = spans().find(span => span.text.trim() === "qw");
    if (!original) throw new Error("Missing source ID prefix");
    await screen.mockMouse.pressDown(label.x + 5, label.y);
    await screen.mockMouse.emitMouseEvent("drag", target.x + 5, target.y);
    await screen.waitForVisualIdle();
    const highlighted = spans().find(span => span.text.trim() === source.changeId);
    if (!highlighted) throw new Error("Missing highlighted source ID");
    expect(highlighted.bg).not.toEqual(original.bg);
    expect(highlighted.bg).not.toEqual(spans().find(span => span.text.trim() === "[feature]")?.bg);
    expect(screen.captureCharFrame()).toContain("● ○");
    expect(screen.captureCharFrame()).toContain("→ ○");
    log.cancelDrag();
    await screen.mockMouse.release(target.x + 5, target.y);
    await screen.waitForVisualIdle();
    expect(spans().find(span => span.text.trim() === "qw")?.bg).toEqual(original.bg);
    expect(screen.captureCharFrame()).not.toContain("● ○");
    expect(screen.captureCharFrame()).not.toContain("→ ○");
  } finally { log.destroyRecursively(); screen.renderer.destroy(); }
});

test("partial repaints restore conflicted bookmark badges, drop targets and source markers", async () => {
  const { RGBA } = await import("@opentui/core");
  const { RevisionLog } = await import("../../src/revisions/revision-log");
  const { darkTheme, setTheme } = await import("../../src/ui/theme");
  const screen = await createTestRenderer({ width: 90, height: 10 });
  setTheme(screen.renderer, darkTheme);
  const log = new RevisionLog(screen.renderer);
  screen.renderer.root.add(log);
  const revisions = ["a", "b", "c"].map(id => ({
    changeId: `${id}qwertyu`, changePrefix: id, commitId: id.repeat(40), description: id,
    author: "Test User", bookmarks: "", parents: [], workingCopy: false, conflict: false,
  }));
  const [panel, drop, selected] = [darkTheme.panel, darkTheme.drop, darkTheme.graphSelected].map(color => RGBA.fromHex(color));
  try {
    log.setSnapshot({ root: "/test", revisions, graph: revisions.map(revision => ({ kind: "revision", revision, prefix: "○  " })) },
      [{ name: "bm", remote: "", conflict: true, targets: ["a".repeat(40), "b".repeat(40)] }]);
    log.canDrag = () => true;
    screen.renderer.root.onMouse = event => log.handleDragMouse(event);
    await screen.waitForVisualIdle();
    const node = (id: string) => {
      const found = screen.renderer.root.findDescendantById(id);
      if (!found) throw new Error(`Missing ${id}`);
      return found;
    };
    const lines = () => screen.captureSpans().lines;
    const badges = () => [0, 1].map(row => lines()[node(`revision-label-${row}`).y]?.spans.findLast(span => span.text.trim() === "[bm!]")?.bg);
    const rowBg = (row: number) => lines()[node(`revision-label-${row}`).y]?.spans.at(-1)?.bg;
    expect(badges()).toEqual([selected, panel]);
    const badge = node("bookmark-0-0");
    await screen.mockMouse.pressDown(badge.x + 1, badge.y);
    await screen.mockMouse.emitMouseEvent("drag", node("revision-label-1").x + 5, node("revision-label-1").y);
    await screen.waitForVisualIdle();
    expect(badges()).toEqual([drop, drop]);
    expect(rowBg(1)).toEqual(drop);
    await screen.mockMouse.emitMouseEvent("drag", node("revision-label-2").x + 5, node("revision-label-2").y);
    await screen.waitForVisualIdle();
    expect(badges()).toEqual([drop, drop]);
    expect([rowBg(1), rowBg(2)]).toEqual([panel, drop]);
    log.cancelDrag();
    await screen.mockMouse.release(node("revision-label-2").x + 5, node("revision-label-2").y);
    await screen.waitForVisualIdle();
    expect(badges()).toEqual([selected, panel]);
    expect([rowBg(0), rowBg(1), rowBg(2)]).toEqual([selected, panel, panel]);
    await screen.mockMouse.pressDown(node("revision-label-1").x + 5, node("revision-label-1").y);
    await screen.mockMouse.emitMouseEvent("drag", node("revision-label-2").x + 5, node("revision-label-2").y);
    await screen.mockMouse.emitMouseEvent("drag", node("revision-label-0").x + 5, node("revision-label-0").y);
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame().match(/[●→] ○/g)).toEqual(["→ ○", "● ○"]);
    expect([rowBg(0), rowBg(1), rowBg(2)]).toEqual([drop, selected, panel]);
    log.cancelDrag();
    await screen.mockMouse.release(node("revision-label-0").x + 5, node("revision-label-0").y);
    log.markSource(2, new Set(["b".repeat(40)]));
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame().match(/[●→▶] ○/g)).toEqual(["● ○", "● ○"]);
    log.markSource(null);
    await screen.waitForVisualIdle();
    expect(screen.captureCharFrame().match(/[●→▶] ○/g)).toEqual(["▶ ○"]);
    expect([rowBg(0), rowBg(1), rowBg(2)]).toEqual([panel, selected, panel]);
  } finally { log.destroyRecursively(); screen.renderer.destroy(); }
});

test("rows outside the viewport are painted when they scroll into view and after a reused refresh", async () => {
  const screen = await createTestRenderer({ width: 60, height: 20 });
  const log = new RevisionLog(screen.renderer);
  screen.renderer.root.add(log);
  const snapshot = (label: string): Snapshot => {
    const revisions = Array.from({ length: 300 }, (_, i): Revision => ({
      commitId: i.toString(16).padStart(40, "0"), changeId: `z${"k".repeat(i % 20)}l`, changePrefix: "z",
      description: `${label} ${i}`, author: "a", bookmarks: "", parents: [], workingCopy: false, conflict: false,
    }));
    return { root: "/", revisions, hasMore: false,
      graph: revisions.flatMap((revision): GraphRow[] => [{ kind: "revision", revision, prefix: "○  " }, { kind: "description", revision, prefix: "│  " }]) };
  };
  const text = (row: number) => screen.renderer.root.findDescendantById(`revision-label-${row}`) as TextRenderable;
  try {
    log.setSnapshot(snapshot("First"), []);
    await screen.renderOnce();
    expect(text(1).plainText).toContain("First 0");
    log.setSelectedIndex(299);
    await screen.renderOnce();
    // Selecting scrolls the revision's heading row into view; the frame after the jump already shows painted rows.
    expect(text(597).plainText).toContain("First 298");
    expect(screen.captureCharFrame()).toContain("First 298");
    log.setSnapshot(snapshot("Second"), []);
    log.setSelectedIndex(0);
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("Second 0");
    expect(screen.captureCharFrame()).not.toContain("First");
  } finally { screen.renderer.destroy(); }
});

const blankRows = (frame: string, height: number) => frame.split("\n").slice(0, height).filter(line => !line.trim()).length;
function longSnapshot(label: string, count: number): Snapshot {
  const revisions = Array.from({ length: count }, (_, i): Revision => ({
    commitId: i.toString(16).padStart(40, "0"), changeId: `z${"k".repeat(i % 20)}l`, changePrefix: "z",
    description: `${label} ${i}`, author: "a", bookmarks: "", parents: [], workingCopy: false, conflict: false,
  }));
  return { root: "/", revisions, hasMore: false,
    graph: revisions.flatMap((revision): GraphRow[] => [{ kind: "revision", revision, prefix: "○  " }, { kind: "description", revision, prefix: "│  " }]) };
}

test("the first frame fills a terminal taller than the default paint window", async () => {
  const screen = await createTestRenderer({ width: 60, height: 100 });
  const log = new RevisionLog(screen.renderer);
  screen.renderer.root.add(log);
  try {
    log.setSnapshot(longSnapshot("First", 400), []);
    await screen.renderOnce();
    expect(blankRows(screen.captureCharFrame(), 100)).toBe(0);
  } finally { screen.renderer.destroy(); }
});

test("a snapshot shorter than the scroll position is painted in its first frame", async () => {
  const screen = await createTestRenderer({ width: 60, height: 20 });
  const log = new RevisionLog(screen.renderer);
  screen.renderer.root.add(log);
  try {
    log.setSnapshot(longSnapshot("First", 400), []);
    await screen.renderOnce();
    log.scrollBy(700);
    await screen.renderOnce();
    const top = log.scrollTop;
    log.setSnapshot(longSnapshot("Second", 150), []);
    log.setSelectedIndex(149);
    log.scrollTop = top;
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    expect(blankRows(frame, 20)).toBe(0);
    expect(frame).toContain("Second 149");
    expect(frame).not.toContain("First");
  } finally { screen.renderer.destroy(); }
});
