import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Repository } from "../src/repository";
import { createApp } from "../src/app";
import { fixture } from "./fixture";

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
