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
  const options = () => chooser(ui).options.map(option => option.name);
  expect(options()).toEqual(["[ ] M hello.txt", "[ ] A one.txt", "Continue"]);
  expect(chooser(ui).getSelectedOption()?.name).toBe("[ ] M hello.txt");
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
