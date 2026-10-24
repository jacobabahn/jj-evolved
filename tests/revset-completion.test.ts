import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputRenderable } from "@opentui/core";
import { revsetCompletions, applyCompletion, historyCompletions } from "../src/revisions/revset-completion";
import { fileRevsetHistory, recordRevset, revsetHistoryLimit } from "../src/revisions/revset-history";
import { Repository } from "../src/repository/repository";
import { fixture } from "./fixture";
import { createUiFixture } from "../tooling/ui";
const list = ["main", "map", "release-", "feature/topic"].map(name => ({ name, remote: "", targets: [], conflict: false }));
list.push({ name: "main", remote: "origin", targets: [], conflict: false });
const bookmarks = { bookmarks: list };

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
  expect(applyCompletion("anc(@)", revsetCompletions("anc(@)", 3, {})[0]!).value).toBe("ancestors(@)");
  const weird = [{ name: 'odd"name', remote: "remote-", targets: [], conflict: false }];
  expect(revsetCompletions('"odd\\"', 6, { bookmarks: weird })[0]?.text).toBe('"odd\\"name"@"remote-"');
});

test("functions show signatures and place the cursor between parentheses that take arguments", () => {
  const [ancestors] = revsetCompletions("ance | @", 4, {});
  expect(ancestors).toMatchObject({ kind: "function", label: "ancestors(x, [depth])", detail: "same as ::x" });
  expect(applyCompletion("ance | @", ancestors!)).toEqual({ value: "ancestors() | @", cursor: 10 });
  const [all] = revsetCompletions("al", 2, {});
  expect(applyCompletion("al", all!)).toEqual({ value: "all()", cursor: 5 });
});

test("aliases and tags complete alongside bookmarks", () => {
  const symbols = {
    tags: ["v1.0", "release"],
    aliases: [{ name: "wip", definition: "description(wip)" }, { name: "by(x, y)", definition: "author(x)\n  | committer(y)" }, { name: "mine_open()", definition: "mine() & ~::trunk()" }],
  };
  const tags = revsetCompletions("v1", 2, symbols);
  expect(tags).toMatchObject([{ kind: "tag", label: "v1.0", text: '"v1.0"', detail: "tag" }]);
  expect(revsetCompletions("rel", 3, { ...symbols, ...bookmarks }).map(item => [item.label, item.kind])).toEqual([["release", "tag"], ["release-", "bookmark"]]);
  expect(revsetCompletions("wi", 2, symbols)[0]).toMatchObject({ kind: "alias", text: "wip", detail: "alias: description(wip)" });
  const by = revsetCompletions("x | b", 5, symbols).find(item => item.kind === "alias")!;
  expect(by).toMatchObject({ label: "by(x, y)", detail: "alias: author(x) | committer(y)" });
  expect(applyCompletion("x | b", by)).toEqual({ value: "x | by()", cursor: 7 });
  expect(applyCompletion("mine_o", revsetCompletions("mine_o", 6, symbols)[0]!).value).toBe("mine_open()");
  // Inside a quoted or remote symbol only names apply, never functions or aliases.
  expect(revsetCompletions('"wi', 3, symbols)).toEqual([]);
});

test("history suggests recent expressions that extend the whole input", () => {
  const history = ["main | @", "mine()", "all()"];
  expect(historyCompletions("all()", history, true).map(item => item.text)).toEqual(["main | @", "mine()"]);
  expect(historyCompletions("mi", history, false).map(item => item.text)).toEqual(["mine()"]);
  expect(applyCompletion("m", historyCompletions("m", history, false)[0]!)).toEqual({ value: "main | @", cursor: 8 });
  expect(recordRevset(history, "  all() ")).toEqual(["all()", "main | @", "mine()"]);
  expect(recordRevset(history, " ")).toEqual(history);
  expect(recordRevset(Array.from({ length: revsetHistoryLimit }, (_, index) => `${index}`), "new")).toHaveLength(revsetHistoryLimit);
});

test("history files keep each repository's entries and tolerate a missing or corrupt file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jj-evolved-history-"));
  try {
    const path = join(directory, "state", "revset-history.json");
    const first = fileRevsetHistory("/repo/one", path), second = fileRevsetHistory("/repo/two", path);
    expect(await first.load()).toEqual([]);
    await first.save(["main", "all()"]);
    await second.save(["tags()"]);
    expect(await first.load()).toEqual(["main", "all()"]);
    expect(await second.load()).toEqual(["tags()"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ repositories: { "/repo/one": ["main", "all()"], "/repo/two": ["tags()"] } });
    await writeFile(path, "{ not json");
    expect(await first.load()).toEqual([]);
    await first.save(["mine()"]);
    expect(await first.load()).toEqual(["mine()"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the repository lists local tags and configured aliases, without jj's internal ones", async () => {
  const f = await fixture();
  try {
    await f.jj("tag", "set", "v1.0", "-r", "@-");
    await f.jj("config", "set", "--repo", 'revset-aliases."by(x, y)"', "author(x)");
    await f.jj("config", "set", "--repo", "revset-aliases.wip", "description(wip)");
    const { tags, aliases } = await (await Repository.open(f.path)).revsetSymbols();
    expect(tags).toEqual(["v1.0"]);
    expect(aliases).toContainEqual({ name: "by(x, y)", definition: "author(x)" });
    expect(aliases).toContainEqual({ name: "wip", definition: "description(wip)" });
    expect(aliases.map(alias => alias.name)).toContain("trunk()");
    expect(aliases.some(alias => alias.name.startsWith("builtin_"))).toBe(false);
  } finally {
    await f.cleanup();
  }
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
  expect(input.value).toBe("does_not_exist");
  ui.key("ESCAPE");
  await Bun.sleep(80);
  await ui.until("revset: main");
  expect(ui.screen.renderer.root.findDescendantById("action-overlay")?.visible).toBe(false);
  expect(await ui.repo.operationId()).toBe(operation);
});

test("arrow keys choose aliases, tags and signatures as you type; reopening offers recent revsets", async () => {
  await using ui = await createUiFixture({ width: 80, height: 24, prepare: async f => {
    await f.jj("tag", "set", "v1.0", "-r", "@-");
    await f.jj("config", "set", "--repo", "revset-aliases.zz_initial", 'description("Initial")');
  } });
  ui.key("L"); ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  const input = ui.node("prompt-input") as InputRenderable;
  await ui.type("zz");
  await ui.until("alias: description(\"Initial\")");
  ui.key("ARROW_DOWN"); expect(input.value).toBe("zz_initial");
  ui.key("RETURN");
  await ui.until("revset: zz_initial");
  await ui.until("Ready.");

  ui.key("L"); ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  await ui.type("v1");
  await ui.until("v1.0");
  ui.key("ARROW_DOWN"); expect(input.value).toBe('"v1.0"');
  ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  await ui.type("ancestors");
  await ui.until("ancestors(x, [depth])");
  ui.key("ARROW_DOWN"); expect(input.value).toBe("ancestors()");
  expect(input.cursorOffset).toBe("ancestors(".length);
  await ui.type("@");
  ui.key("RETURN");
  await ui.until("revset: ancestors(@)");
  await ui.until("Ready.");

  // Reopening lists earlier expressions, most recent first, excluding the active one.
  ui.key("L");
  await ui.until("1 recent revset");
  expect(ui.screen.captureCharFrame()).not.toContain("Tab/↓");
  expect(ui.screen.captureCharFrame()).toContain("zz_initial");
  ui.key("ARROW_UP"); expect(input.value).toBe("zz_initial");
  ui.key("ESCAPE");
  await ui.until("revset: ancestors(@)");
  // Typing filters history to expressions extending the input, above the token completions.
  ui.key("L"); ui.key("a", { ctrl: true }); ui.key("k", { ctrl: true });
  await ui.type("zz_");
  await ui.until("recent");
  ui.key("ARROW_DOWN"); expect(input.value).toBe("zz_initial");
  ui.key("ESCAPE");
});
