import { expect, test } from "bun:test";
import { InputRenderable, SelectRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";
import { Repository } from "../src/repository/repository";
import type { Revision } from "../src/repository/model";
import { matchingRevisions, withResolution } from "../src/ui/revision-search";
import { fixture } from "./fixture";

for (const action of ["Rebase", "Squash"]) {
  test(`${action} destination search excludes source, handles no matches and cancels`, () => withUiFixture("destination-search", async ui => {
    const operation = await ui.repo.operationId();
    ui.key(" "); ui.choose(action);
    await ui.until("Destination: Choose a revision");
    ui.key("RETURN"); await ui.until("/ search all destinations");
    ui.key("/"); await ui.type("Next change");
    await ui.until("No matching destinations");
    ui.key("RETURN");
    expect(ui.node("history-destination-search").focused).toBe(true);
    ui.key("ESCAPE"); await Bun.sleep(60); await ui.until("/ search all destinations");
    expect(ui.node("history-choices").focused).toBe(true);
    ui.key("/"); await ui.type("FEATURE");
    await ui.until("1 destination");
    const choices = ui.node("history-choices") as SelectRenderable;
    expect(choices.options[0]?.name).toContain("Initial feature");
    ui.key("ESCAPE"); await Bun.sleep(60); ui.key("ESCAPE"); await Bun.sleep(60);
    await ui.until("Destination: Choose a revision");
    ui.key("ESCAPE"); await Bun.sleep(60);
    expect(await ui.repo.operationId()).toBe(operation);
  }), 15_000);
}

test("interactive destination picker searches full IDs and cancels without editing", () => withUiFixture("interactive-destination-search", async ui => {
  const revision = (await ui.repo.snapshot("feature")).revisions[0]!;
  const operation = await ui.repo.operationId();
  ui.key(" "); ui.choose("Squash in diff editor");
  await ui.until("/ search all destinations");
  ui.key("/"); await ui.type(revision.commitId);
  await ui.until("Initial feature, listed first");
  expect((ui.node("action-choices") as SelectRenderable).options[0]?.name).toContain("Initial feature");
  const input = ui.node("destination-search") as InputRenderable;
  input.value = "missing needle";
  input.emit("input", input.value);
  await ui.until("No matching destinations");
  ui.key("RETURN");
  expect(input.focused).toBe(true);
  ui.key("ESCAPE"); await Bun.sleep(60);
  await ui.until("/ search all destinations");
  expect(ui.node("action-choices").focused).toBe(true);
  ui.key("ESCAPE"); await Bun.sleep(60);
  expect(await ui.repo.operationId()).toBe(operation);
}), 15_000);

test("resolve names one revision through jj, or explains why it cannot", async () => {
  const f = await fixture();
  try {
    await f.jj("tag", "set", "v1.0", "-r", "feature");
    const repo = await Repository.open(f.path);
    const feature = (await repo.navigationRevisions("feature"))[0]!;
    for (const query of ["v1.0", "feature", feature.changeId.slice(0, 6), feature.commitId, "heads(::feature)", "@-"]) {
      const resolution = await repo.resolve(query);
      expect(resolution.kind === "one" && resolution.revision.commitId).toBe(feature.commitId);
    }
    expect(feature.tags).toBe("v1.0");
    expect(await repo.resolve("all()")).toEqual({ kind: "several", count: 3, more: false });
    expect(await repo.resolve("all()", 2)).toEqual({ kind: "several", count: 2, more: true });
    expect(await repo.resolve("nosuch")).toEqual({ kind: "none", message: "Revision `nosuch` doesn't exist" });
    expect(await repo.resolve("none()")).toEqual({ kind: "none", message: "`none()` resolves to no revisions." });
    // jj follows a syntax error with a caret diagram; only its first line is kept.
    expect(await repo.resolve("feature (")).toEqual({ kind: "none", message: "Failed to parse revset: Syntax error" });
  } finally { await f.cleanup(); }
});

test("a resolved revision is listed first; several, none or the source are never offered", () => {
  const revision = (id: string, description: string, extra: Partial<Revision> = {}): Revision => ({
    commitId: id.repeat(40), changeId: "k".repeat(32 - id.length) + "z".repeat(id.length), changePrefix: "k", description, author: "a",
    bookmarks: "", tags: "", parents: [], workingCopy: false, conflict: false, ...extra,
  });
  const [a, b, source] = [revision("a", "Alpha", { tags: "v1.0 stable" }), revision("b", "Beta"), revision("c", "Source")];
  expect(matchingRevisions([a, b], [], "STABLE")).toEqual([a]);
  expect(withResolution("b", { kind: "one", revision: b }, [a, b], source)).toEqual({ matches: [b, a], status: `Resolves to ${b.changeId.slice(0, 8)} Beta, listed first` });
  expect(withResolution("@", { kind: "one", revision: source }, [], source)).toEqual({ matches: [], status: "That is the change being moved. Choose another destination." });
  expect(withResolution("all()", { kind: "several", count: 100, more: true }, [], source).status)
    .toBe("Resolves to 100+ revisions, but a destination must be one. Narrow it, for example with latest(all()).");
  expect(withResolution("alpha", { kind: "several", count: 2, more: false }, [a], source))
    .toEqual({ matches: [a], status: "1 destination by text; as a revset it names 2 revisions, not one" });
  expect(withResolution("zz", { kind: "none", message: "Change ID prefix `zz` is ambiguous" }, [], source).status)
    .toBe("No matching destinations. Change ID prefix `zz` is ambiguous");
  expect(withResolution("alpha", { kind: "none", message: "Revision `alpha` doesn't exist" }, [a, b], source).status).toBe("2 destinations");
});

test("the rebase form resolves a typed tag or revset, keeps the scope, and rejects several revisions", () => withUiFixture("destination-revsets", async ui => {
  const feature = (await ui.repo.snapshot("feature")).revisions[0]!;
  const choices = () => ui.node("history-choices") as SelectRenderable;
  ui.key(" "); ui.choose("Rebase");
  await ui.until("Destination: Choose a revision");
  // Change the scope first: opening and cancelling the picker must not reset it.
  ui.key("j"); ui.key("RETURN");
  await ui.until("Scope: Change and descendants");
  await ui.until("Choose a destination first.");
  ui.key("k"); ui.key("RETURN");
  await ui.until("/ search all destinations");
  ui.key("/"); await ui.type("all()");
  await ui.until("but a destination must be one");
  expect(choices().options).toHaveLength(0);
  ui.key("RETURN");
  await Bun.sleep(100);
  expect(ui.node("history-destination-search").focused).toBe(true);
  ui.key("ESCAPE"); await Bun.sleep(60);
  ui.key("ESCAPE"); await Bun.sleep(60);
  await ui.until("Scope: Change and descendants");
  expect(ui.screen.captureCharFrame()).toContain("Destination: Choose a revision");
  ui.key("RETURN"); await ui.until("/ search all destinations");
  // A tag is found by text, and jj resolves the same name exactly.
  ui.key("/"); await ui.type("release");
  expect(choices().options.map(option => option.name)).toEqual([expect.stringContaining("Initial feature")]);
  ui.key("ESCAPE"); await Bun.sleep(60);
  // parents(@) matches no text, so an Enter right after typing must wait for jj to resolve it.
  ui.key("/"); await ui.type("parents(@)"); ui.key("RETURN");
  await ui.until("Preview ready");
  expect((ui.node("history-fields") as SelectRenderable).options[0]?.name).toBe(`Destination: ${feature.changeId.slice(0, 8)} Initial feature`);
  await ui.until("Scope: Change and descendants");
}, { prepare: async f => { await f.jj("tag", "set", "release-1", "-r", "feature"); } }), 15_000);

test("a destination rewritten after it was resolved is refused before applying", () => withUiFixture("destination-stale", async ui => {
  const operation = await ui.repo.operationId();
  ui.key(" "); ui.choose("Rebase");
  await ui.until("Destination: Choose a revision");
  ui.key("RETURN"); await ui.until("/ search all destinations");
  ui.key("/"); await ui.type("heads(::feature)");
  await ui.until("Initial feature, listed first");
  ui.key("RETURN");
  await ui.until("Preview ready");
  await ui.f.jj("describe", "-r", "feature", "-m", "Rewritten elsewhere");
  const rewritten = await ui.repo.operationId();
  ui.key("j"); ui.key("j"); ui.key("RETURN");
  // The full message wraps differently with the screen width, so wait for its first words.
  await ui.until("Repository changed since this preview.");
  expect(ui.screen.captureCharFrame()).not.toContain("Rebased ");
  ui.key("p");
  await ui.until("The selected revision has changed");
  // Nothing was applied after the external rewrite.
  expect(await ui.repo.operationId()).toBe(rewritten);
  expect(rewritten).not.toBe(operation);
}), 15_000);

test("the bookmark move picker resolves a revset to a revision beyond the first 200", () => withUiFixture("destination-revset-deep", async ui => {
  const feature = (await ui.repo.snapshot("feature")).revisions[0]!;
  ui.key("b");
  await ui.until("Git remotes");
  ui.choose("work");
  await ui.until("Move bookmark");
  ui.choose("Move bookmark");
  await ui.until("/ search all destinations");
  ui.key("/"); await ui.type("roots(feature::) & ~root()");
  await ui.until("Initial feature, listed first");
  expect((ui.node("action-choices") as SelectRenderable).options[0]?.name).toContain(feature.changeId.slice(0, 8));
  ui.key("RETURN");
  await ui.until("Review before applying");
  expect(ui.screen.captureCharFrame()).toContain(feature.commitId.slice(0, 12));
}, { prepare: async f => {
  for (let i = 0; i < 202; i++) await f.jj("new", "-m", `Filler ${i}`);
  await f.jj("bookmark", "create", "work");
} }), 30_000);
