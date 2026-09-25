import { expect, test } from "bun:test";
import { InputRenderable, SelectRenderable } from "@opentui/core";
import { withUiFixture } from "../tooling/ui";

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
    await ui.until("1 destinations");
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
  await ui.until("1 destinations");
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
