import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionForKey, bindingLabel, inlineActions, KeySequence, keyLabel, defaultBindings, jjuiBindings, legacyBindings, loadKeybindings, parseKeybindings, parsePreset, presetNames, readKeybindings, scopeActions, scopeNames } from "../../src/ui/keybindings";

test("defaults and overrides preserve independent arrays and support unbinding", () => {
  expect(defaultBindings).toBe(jjuiBindings);
  expect(parseKeybindings({ bindings: {} })).toEqual(defaultBindings);
  expect(parseKeybindings({})).toEqual(defaultBindings);
  const custom = parseKeybindings({ bindings: { down: ["x"], help: [] } });
  expect(custom.down).toEqual(["x"]);
  expect(custom.help).toEqual([]);
  custom.up.push("y");
  expect(defaultBindings.up).toEqual(["k", "up"]);
});

test("presets select jjui or legacy defaults and accept overrides on top", () => {
  expect(parseKeybindings({ preset: "jjui" })).toEqual(jjuiBindings);
  expect(parseKeybindings({ preset: "legacy" })).toEqual(legacyBindings);
  expect(legacyBindings).toMatchObject({ describe: ["d"], refresh: ["r"], rebase: ["R"], absorb: ["a"], status: ["s"], filter: ["/"], search: ["ctrl+f"], loadMore: ["L"], files: ["f"], diff: ["return"], abandon: [], split: [], git: [], describeExternal: [] });
  expect(jjuiBindings).toMatchObject({ describe: ["return"], describeExternal: ["D"], diff: ["d"], refresh: ["ctrl+r"], rebase: ["r"], abandon: ["a"], absorb: ["A"], split: ["s"], filter: ["L"], search: ["/"], nextMatch: ["'"], previousMatch: ['"'], files: ["l", "right"], git: ["g"] });
  expect(parseKeybindings({ preset: "legacy", bindings: { refresh: ["ctrl+r"] } })).toMatchObject({ refresh: ["ctrl+r"], describe: ["d"] });
  expect(() => parseKeybindings({ preset: "vim" })).toThrow("Unknown preset");
  expect(() => parseKeybindings({ preset: 1 })).toThrow("Unknown preset");
  for (const preset of [jjuiBindings, legacyBindings]) {
    for (const scope of scopeNames) {
      const keys = scopeActions[scope].flatMap(action => preset[action]);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(preset.rebaseScope).toEqual(["tab"]);
    expect(preset.focus).toEqual(["tab"]);
  }
});

test("rebaseScope shares keys with browse-only actions but not with actions live during destination choice", () => {
  expect(inlineActions).toEqual(["down", "up", "pageUp", "pageDown", "search", "rebaseScope", "loadMore", "togglePreview"]);
  const shared = parseKeybindings({ bindings: { rebaseScope: ["s"] } });
  const key = { name: "s", sequence: "s", ctrl: false, shift: false, meta: false, option: false };
  expect(actionForKey(shared, key)).toBe("split");
  expect(actionForKey(shared, key, inlineActions)).toBe("rebaseScope");
  expect(parseKeybindings({ bindings: { rebaseScope: ["s"] } })).toMatchObject({ rebaseScope: ["s"], split: ["s"] });
  for (const key of ["return", "escape"]) expect(() => parseKeybindings({ bindings: { rebaseScope: [key] } })).toThrow("reserved for inline destination controls");
  expect(() => parseKeybindings({ bindings: { rebaseScope: ["j"] } })).toThrow("conflicts between down and rebaseScope");
  expect(() => parseKeybindings({ bindings: { rebaseScope: ["/"] } })).toThrow("conflicts between search and rebaseScope");
  // Remapped movement and search keys drive the inline destination picker too.
  const remapped = parseKeybindings({ bindings: { down: ["x"], search: ["ctrl+f"] } });
  expect(actionForKey(remapped, { ...key, name: "x", sequence: "x" }, inlineActions)).toBe("down");
  expect(actionForKey(remapped, { ...key, name: "f", sequence: "\x06", ctrl: true }, inlineActions)).toBe("search");
  expect(parseKeybindings({ bindings: { focus: ["ctrl+t"] } })).toMatchObject({ focus: ["ctrl+t"], rebaseScope: ["tab"] });
  expect(() => parseKeybindings({ bindings: { rebaseScope: ["ctrl+l"] } })).toThrow("conflicts between loadMore and rebaseScope");
  expect(() => parseKeybindings({ bindings: { rebaseScope: ["p"] } })).toThrow("conflicts between rebaseScope and togglePreview");
  expect(() => parseKeybindings({ bindings: { rebaseScope: ["x"], loadMore: ["x"] } })).toThrow("conflicts between loadMore and rebaseScope");
  expect(() => parseKeybindings({ bindings: { status: ["tab"] } })).toThrow("conflicts between focus and status");
  expect(() => parseKeybindings({ bindings: { rebaseScope: ["x"], togglePreview: ["x"] } })).toThrow("conflicts between rebaseScope and togglePreview");
});

test("rejects malformed configuration, unknown actions, terminal aliases and collisions", () => {
  for (const config of [null, [], { bindings: [] }, { extra: true, bindings: {} }, { bindings: { unknown: [] } }, { bindings: { preview: ["x"] } }, { bindings: { help: "h" } }, { bindings: { help: ["ctrl+c"] } }, { bindings: { help: ["ctrl+m"] } }, { bindings: { help: ["F13"] } }]) {
    expect(() => parseKeybindings(config)).toThrow();
  }
  expect(() => parseKeybindings({ bindings: { help: ["j"] } })).toThrow("conflicts between down and help");
  expect(parseKeybindings({ bindings: { help: ["j"], down: ["h"] } }).help).toEqual(["j"]);
});

test("matching separates control, shifted and modified keys", () => {
  const event = { name: "r", sequence: "r", ctrl: false, shift: false, meta: false, option: false };
  expect(actionForKey(defaultBindings, event)).toBe("rebase");
  expect(actionForKey(defaultBindings, { ...event, ctrl: true })).toBe("refresh");
  expect(actionForKey(defaultBindings, { ...event, meta: true })).toBeUndefined();
  expect(actionForKey(defaultBindings, { ...event, name: "r", sequence: "R", shift: true })).toBeUndefined();
  expect(actionForKey(defaultBindings, { ...event, name: "d", sequence: "D", shift: true })).toBe("describeExternal");
  expect(actionForKey(defaultBindings, { ...event, name: "'", sequence: "'" })).toBe("nextMatch");
  expect(actionForKey(defaultBindings, { ...event, name: '"', sequence: '"', shift: true })).toBe("previousMatch");
  expect(actionForKey(defaultBindings, { ...event, name: "right", sequence: "\u001b[C" })).toBe("files");
  expect(actionForKey(defaultBindings, { ...event, name: "return", sequence: "\r" })).toBe("describe");
  expect(actionForKey(legacyBindings, { ...event, name: "r", sequence: "R", shift: true })).toBe("rebase");
  const tab = { ...event, name: "tab", sequence: "\t" };
  expect(actionForKey(defaultBindings, tab)).toBe("focus");
  expect(actionForKey(defaultBindings, tab, inlineActions)).toBe("rebaseScope");
  expect(actionForKey(defaultBindings, { ...event, name: "s", sequence: "s" }, inlineActions)).toBeUndefined();
  expect(actionForKey(defaultBindings, { ...event, name: "p", sequence: "p" }, inlineActions)).toBe("togglePreview");
});

test("missing configuration uses defaults and invalid files report their path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jj-evolved-keys-"));
  const path = join(directory, "keybindings.json");
  try {
    expect(await readKeybindings(path)).toMatchObject({ preset: "jjui", custom: false, bindings: defaultBindings, scopes: { files: defaultBindings } });
    expect(await readKeybindings(path, "legacy")).toMatchObject({ preset: "legacy", custom: false, bindings: legacyBindings });
    await writeFile(path, '{"bindings":{"help":["h"]}}');
    expect(await readKeybindings(path)).toMatchObject({ preset: "jjui", custom: true, bindings: { help: ["h"], describe: ["return"] } });
    await writeFile(path, '{"preset":"legacy"}');
    expect(await readKeybindings(path)).toMatchObject({ preset: "legacy", custom: false, bindings: { describe: ["d"] } });
    await writeFile(path, "not json");
    await expect(readKeybindings(path)).rejects.toThrow(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an explicit preset replaces the file preset while file bindings still apply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jj-evolved-keys-"));
  const path = join(directory, "keybindings.json");
  try {
    await writeFile(path, '{"preset":"jjui","bindings":{"help":["h"]}}');
    expect(await readKeybindings(path, "legacy")).toMatchObject({ preset: "legacy", custom: true, bindings: { help: ["h"], describe: ["d"], refresh: ["r"] } });
    expect(await readKeybindings(path, "jjui")).toMatchObject({ preset: "jjui", bindings: { help: ["h"], describe: ["return"] } });
    await writeFile(path, '{"preset":"vim"}');
    await expect(readKeybindings(path, "legacy")).rejects.toThrow('Unknown preset "vim"');
  } finally { await rm(directory, { recursive: true, force: true }); }
  expect(presetNames).toEqual(["jjui", "legacy"]);
  expect(parsePreset("legacy")).toBe("legacy");
  expect(() => parsePreset("vim", "--keys")).toThrow('Unknown preset "vim" from --keys. Use one of: jjui, legacy.');
  expect(() => parsePreset(undefined)).toThrow("Use one of: jjui, legacy.");
  expect(loadKeybindings({ bindings: {} })).toMatchObject({ preset: "jjui", custom: false, bindings: jjuiBindings });
  expect(loadKeybindings({ preset: "jjui", bindings: { down: ["x"] } }, "legacy")).toMatchObject({ preset: "legacy", custom: true, bindings: { down: ["x"], up: ["k", "up"], describe: ["d"] } });
});

test("labels name control, named and literal keys", () => {
  const bindings = parseKeybindings({ bindings: { down: ["/", "down"], search: ["x"] } });
  expect(keyLabel(bindings, "down", true)).toBe("/");
  expect(keyLabel(defaultBindings, "refresh")).toBe("^R");
  expect(keyLabel(defaultBindings, "files")).toBe("l/Right");
  expect(keyLabel(defaultBindings, "describe")).toBe("Enter");
  expect(keyLabel(parseKeybindings({ bindings: { help: [] } }), "help")).toBe("unbound");
  expect(keyLabel(defaultBindings, "rebaseScope")).toBe("Tab");
});

const press = (sequence: string, extra: Partial<{ name: string; ctrl: boolean; shift: boolean }> = {}) =>
  ({ name: sequence.toLowerCase(), sequence, ctrl: false, shift: sequence !== sequence.toLowerCase(), meta: false, option: false, ...extra });

test("a sequence runs only when complete; a prefix waits, a wrong key or Escape abandons it", () => {
  const { scopes } = loadKeybindings({ bindings: { theme: ["z t"], help: ["?", "z h"], operations: ["ctrl+x o"] } });
  const actions = scopeActions.revisions, keys = new KeySequence();
  expect(keys.feed(scopes.revisions, actions, press("z"), "browse")).toEqual({ kind: "pending", keys: ["z"] });
  expect(keys.pendingIn("browse")).toEqual(["z"]);
  expect(keys.continuations(scopes.revisions, actions)).toEqual([["t", "theme"], ["h", "help"]]);
  expect(keys.feed(scopes.revisions, actions, press("t"), "browse")).toEqual({ kind: "action", action: "theme" });
  expect(keys.pendingIn("browse")).toEqual([]);
  // t on its own is unbound now; ? still runs help.
  expect(keys.feed(scopes.revisions, actions, press("t"), "browse")).toEqual({ kind: "none" });
  expect(keys.feed(scopes.revisions, actions, press("?"), "browse")).toEqual({ kind: "action", action: "help" });
  // A key that finishes no sequence is swallowed with the prefix, rather than running its own action (j is down).
  keys.feed(scopes.revisions, actions, press("z"), "browse");
  expect(keys.feed(scopes.revisions, actions, press("j"), "browse")).toEqual({ kind: "unbound", keys: ["z", "j"] });
  keys.feed(scopes.revisions, actions, press("x", { ctrl: true }), "browse");
  expect(keys.feed(scopes.revisions, actions, press("escape"), "browse")).toEqual({ kind: "cancelled", keys: ["ctrl+x"] });
  expect(keys.feed(scopes.revisions, actions, press("escape"), "browse")).toEqual({ kind: "action", action: "clearSearch" });
  // Keys pressed in another prompt start over.
  keys.feed(scopes.revisions, actions, press("z"), "browse");
  expect(keys.pendingIn("menu")).toEqual([]);
  expect(keys.feed(scopes.revisions, actions, press("h"), "menu")).toEqual({ kind: "none" });
  expect(bindingLabel("ctrl+x o")).toBe("^X o");
  expect(keyLabel(scopes.revisions, "help")).toBe("?/z h");
});

test("sequences are validated: length, escape, and a binding that starts another", () => {
  expect(() => parseKeybindings({ bindings: { theme: ["a b c d"] } })).toThrow("too long");
  expect(() => parseKeybindings({ bindings: { theme: ["z  t"] } })).toThrow("separate the keys of a sequence with single spaces");
  expect(() => parseKeybindings({ bindings: { theme: ["z escape"] } })).toThrow("cannot contain escape");
  // g opens the Git menu by default, so g t could never be reached.
  expect(() => parseKeybindings({ bindings: { theme: ["g t"] } })).toThrow("Key g (git) starts the sequence g t (theme) in the revision list, so g could never run git on its own.");
  expect(parseKeybindings({ bindings: { theme: ["g t"], git: ["g g"] } })).toMatchObject({ theme: ["g t"], git: ["g g"] });
  expect(() => parseKeybindings({ bindings: { theme: ["z t"], help: ["z t"] } })).toThrow("Key z t conflicts between theme and help");
});

test("scopes override an action in one place and check conflicts only among the keys live there", () => {
  const config = loadKeybindings({ scopes: { files: { down: ["J"], up: ["K"] }, menu: { back: ["ctrl+b"] }, prompt: { nextCompletion: ["tab", "ctrl+t"] } } });
  expect(config.custom).toBe(true);
  expect(config.bindings.down).toEqual(["j", "down"]);
  expect(config.scopes.revisions.down).toEqual(["j", "down"]);
  expect(config.scopes.files.down).toEqual(["J"]);
  expect(config.scopes.menu.back).toEqual(["ctrl+b"]);
  expect(config.scopes.files.back).toEqual(["h", "left"]);
  expect(config.scopes.prompt.nextCompletion).toEqual(["tab", "ctrl+t"]);
  // A global override reaches every scope that uses the action.
  const global = loadKeybindings({ bindings: { down: ["x", "down"] } });
  for (const scope of ["revisions", "files", "destination", "menu"] as const) expect(global.scopes[scope].down).toEqual(["x", "down"]);
  // ^N scrolls the preview while browsing and completes in prompts; that is no conflict.
  expect(defaultBindings.previewDown).toEqual(["ctrl+n"]);
  expect(defaultBindings.nextCompletion).toContain("ctrl+n");
  // D is describeExternal while browsing, but the file browser does not use it.
  expect(loadKeybindings({ scopes: { files: { down: ["D"] } } }).scopes.files.down).toEqual(["D"]);
  expect(() => loadKeybindings({ scopes: { files: { down: ["l"] } } })).toThrow("Key l conflicts between down and files in the file browser");
  expect(() => loadKeybindings({ scopes: { panes: {} } })).toThrow("Unknown keybinding scope: panes. Use one of: revisions, files, destination, menu, prompt.");
  expect(() => loadKeybindings({ scopes: { files: { rebase: ["r"] } } })).toThrow("Action rebase does not apply in the files scope");
  expect(() => loadKeybindings({ scopes: { files: { nope: ["r"] } } })).toThrow("Unknown keybinding action: nope");
  expect(() => loadKeybindings({ scopes: { files: { down: "J" } } })).toThrow("Keybinding down in files must be an array of keys.");
  expect(() => loadKeybindings({ scopes: [] })).toThrow("Expected a scopes object");
  expect(() => loadKeybindings({ scopes: { menu: { back: ["return"] } } })).toThrow("reserved in menus");
  // back's default h and Left give way to an action bound to them, as the fixed keys they replaced did.
  const helpOnH = loadKeybindings({ bindings: { help: ["h"] } });
  expect(helpOnH.scopes.files.back).toEqual(["left"]);
  expect(helpOnH.scopes.menu.back).toEqual(["left"]);
  expect(loadKeybindings({ scopes: { files: { down: ["h j"] } } }).scopes.files.back).toEqual(["left"]);
  // Bound on purpose, back is checked like any other action.
  expect(() => loadKeybindings({ bindings: { help: ["h"], back: ["h"] } })).toThrow("Key h conflicts between help and back in the file browser");
  expect(() => loadKeybindings({ bindings: { help: ["h"] }, scopes: { menu: { back: ["h"] } } })).toThrow("Key h conflicts between help and back in the menus");
});

test("text prompts accept only keys that typing and editing do not use", () => {
  for (const key of ["x", "X", "space", "left", "return", "ctrl+a", "ctrl+e", "ctrl+w", "ctrl+u", "ctrl+k"]) {
    expect(() => loadKeybindings({ scopes: { prompt: { nextCompletion: [key] } } })).toThrow("would stop text prompts from accepting it");
  }
  // A global override reaches prompts too, so it is checked the same way.
  expect(() => loadKeybindings({ bindings: { saveDescription: ["s"] } })).toThrow("would stop text prompts from accepting it");
  expect(() => loadKeybindings({ scopes: { prompt: { saveDescription: ["ctrl+x s"] } } })).toThrow("Key s for saveDescription");
  expect(loadKeybindings({ scopes: { prompt: { saveDescription: ["ctrl+x ctrl+s"], nextCompletion: ["f2"] } } }).scopes.prompt).toMatchObject({ saveDescription: ["ctrl+x ctrl+s"], nextCompletion: ["f2"] });
});
