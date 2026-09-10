import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Repository } from "../../src/repository/repository";
import { createApp } from "../../src/app";
import { fixture } from "../fixture";

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
