import { expect, test } from "bun:test";
import { join } from "node:path";
import { SelectRenderable } from "@opentui/core";
import { withUiFixture, type UiFixture } from "../tooling/ui";

const chooser = (ui: UiFixture) => ui.node("action-choices") as SelectRenderable;

test("split opens on the first file, marks files with status letters, and continues last", () => withUiFixture("split-rows", async ui => {
  await Bun.write(join(ui.f.path, "one.txt"), "one\n");
  await Bun.write(join(ui.f.path, "hello.txt"), "changed\n");
  ui.key("r", { ctrl: true });
  await ui.until("one.txt");
  await ui.settled();
  ui.key(" ");
  ui.choose("Split (choose files)");
  await ui.until("Select at least one file first");
  // Continue's key gives the list a key column, so names are compared without it.
  const options = () => chooser(ui).options.map(option => option.name.replace(/^c? +/, ""));
  expect(options()).toEqual(["[ ] M hello.txt", "[ ] A one.txt", "Continue"]);
  expect(chooser(ui).getSelectedOption()?.value).toBe("[ ] M hello.txt");
  ui.key("RETURN");
  await ui.until("Continue with 1 file");
  expect(options()).toEqual(["[x] M hello.txt", "[ ] A one.txt", "Continue with 1 file"]);
}, { theme: "dark" }), 15_000);

test("bookmark rows name their change and description, and rename says what it keeps", () => withUiFixture("bookmark-rows", async ui => {
  await ui.until("Empty change.");
  const [feature] = (await ui.repo.snapshot("feature")).revisions;
  ui.key("b");
  await ui.until("Git remotes");
  const row = chooser(ui).options.find(option => option.name === "feature");
  expect(row?.description).toBe(`local · ${feature!.changeId.slice(0, 8)} Initial feature`);
  ui.choose("feature");
  await ui.until("Rename bookmark");
  expect(chooser(ui).options.find(option => option.name === "Rename bookmark")?.description).toBe("Give it a new name; it stays where it is");
}, { theme: "dark" }), 15_000);

test("bookmark rows name targets outside the loaded graph, and a conflicted bookmark's targets by change ID", () => withUiFixture("bookmark-targets", async ui => {
  await ui.f.jj("new", "feature", "-m", "Left side");
  const [left] = (await ui.repo.snapshot("@")).revisions;
  await ui.f.jj("new", "feature", "-m", "Right side");
  const [right] = (await ui.repo.snapshot("@")).revisions;
  await ui.f.jj("bookmark", "create", "conf", "-r", left!.commitId);
  const operation = (await ui.f.jj("op", "log", "--no-graph", "-n", "1", "-T", "id")).trim();
  await ui.f.jj("bookmark", "set", "conf", "--allow-backwards", "-r", "feature");
  await ui.f.jj("--at-op", operation, "bookmark", "set", "conf", "--allow-backwards", "-r", right!.commitId);
  await ui.f.jj("log", "-r", "@");
  ui.key("L");
  await ui.prompt("@");
  ui.key("b");
  await ui.until("Git remotes");
  const description = (name: string) => chooser(ui).options.find(option => option.name.startsWith(name))?.description ?? "";
  const [feature] = (await ui.repo.snapshot("feature")).revisions;
  // feature is outside the revset @, and still named by its change and description.
  expect(description("feature")).toContain(`${feature!.changeId.slice(0, 8)} Initial feature`);
  const conflicted = description("conf");
  expect(conflicted).toContain("conflicted");
  expect(conflicted).not.toContain("side");
  expect(conflicted).toMatch(/[k-z]{8}, [k-z]{8}/);
}, { theme: "dark" }), 15_000);

test("c continues a split from anywhere in the list, and says so when nothing is selected", () => withUiFixture("split-continue", async ui => {
  await Bun.write(join(ui.f.path, "one.txt"), "one\n");
  await Bun.write(join(ui.f.path, "hello.txt"), "changed\n");
  ui.key("r", { ctrl: true });
  await ui.until("one.txt");
  await ui.settled();
  ui.key(" ");
  ui.choose("Split (choose files)");
  await ui.until("c continue");
  ui.key("c");
  await ui.until("Select at least one file.");
  expect(chooser(ui).getSelectedOption()?.name).toContain("Continue");
  ui.key("k"); ui.key("k");
  ui.key("RETURN");
  await ui.until("Continue with 1 file");
  ui.key("c");
  await ui.until("First change description");
}, { theme: "dark" }), 15_000);
