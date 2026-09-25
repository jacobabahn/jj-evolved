import { expect, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import { revsetCompletions, applyCompletion } from "../src/revisions/revset-completion";
import { createUiFixture } from "../tooling/ui";
const bookmarks = ["main", "map", "release-", "feature/topic"].map(name => ({ name, remote: "", targets: [], conflict: false }));
bookmarks.push({ name: "main", remote: "origin", targets: [], conflict: false });

test("completion replaces only the cursor token and preserves surrounding expression", () => {
  const value = "ancestors(ma) | @";
  const items = revsetCompletions(value, 12, bookmarks);
  expect(items.map(item => item.label)).toEqual(["main", "main@origin", "map"]);
  expect(applyCompletion(value, items[0]!)).toEqual({ value: "ancestors(main) | @", cursor: 14 });
  expect(applyCompletion("maIN | @", revsetCompletions("maIN | @", 2, bookmarks)[0]!).value).toBe("main | @");
  expect(revsetCompletions("zz", 2, bookmarks)).toEqual([]);
  for (const value of ["@..ma | @", "@::ma | @"]) {
    expect(applyCompletion(value, revsetCompletions(value, 5, bookmarks)[0]!).value).toBe(value.replace("ma", "main"));
  }
  expect(applyCompletion('ancestors("ma") | @', revsetCompletions('ancestors("ma") | @', 13, bookmarks)[0]!).value).toBe("ancestors(main) | @");
  expect(revsetCompletions("'ma", 3, bookmarks)[0]?.text).toBe("main");
});

test("quoted bookmarks, remote symbols, existing calls, and escaped quotes", () => {
  expect(revsetCompletions("release", 7, bookmarks)[0]?.text).toBe('"release-"');
  expect(revsetCompletions("feature", 7, bookmarks)[0]?.text).toBe('"feature/topic"');
  expect(revsetCompletions("main@o", 6, bookmarks)[0]?.text).toBe("main@origin");
  const quoted = 'parents("feature/to") | @';
  expect(applyCompletion(quoted, revsetCompletions(quoted, 19, bookmarks)[0]!).value).toBe('parents("feature/topic") | @');
  expect(applyCompletion("anc(@)", revsetCompletions("anc(@)", 3, [])[0]!).value).toBe("ancestors(@)");
  const weird = [{ name: 'odd"name', remote: "remote-", targets: [], conflict: false }];
  expect(revsetCompletions('"odd\\"', 6, weird)[0]?.text).toBe('"odd\\"name"@"remote-"');
});

test("80-column revset completion types, cycles, applies, cancels and preserves invalid view", async () => {
  await using ui = await createUiFixture({ width: 80, height: 24, prepare: async f => {
    await f.jj("bookmark", "create", "main", "-r", "@");
    await f.jj("bookmark", "create", "map", "-r", "@-");
  } });
  const operation = await ui.repo.operationId();
  ui.key("L");
  ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  await ui.type("ma");
  await ui.until("4 suggestions");
  const input = ui.node("prompt-input") as InputRenderable;
  ui.key("TAB"); expect(input.value).toBe("main");
  ui.key("TAB"); expect(input.value).toBe("main@git");
  ui.key("TAB", { shift: true }); expect(input.value).toBe("main");
  ui.key("RETURN");
  await ui.until("revset: main");
  await ui.until("Ready.");
  ui.key("L"); ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  await ui.type("does_not_exist");
  await ui.until("No suggestions");
  ui.key("TAB"); expect(input.value).toBe("does_not_exist");
  ui.key("RETURN"); await ui.until("doesn't exist");
  await Bun.sleep(20);
  expect(ui.screen.captureCharFrame()).toContain("revset: main");
  ui.key("ESCAPE");
  await Bun.sleep(80);
  await ui.until("revset: main");
  expect(ui.screen.renderer.root.findDescendantById("action-overlay")?.visible).toBe(false);
  expect(await ui.repo.operationId()).toBe(operation);
});
