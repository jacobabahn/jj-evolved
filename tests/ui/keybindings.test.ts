import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionForKey, inlineActions, keyLabel, defaultBindings, jjuiBindings, legacyBindings, loadKeybindings, parseKeybindings, parsePreset, presetNames, readKeybindings } from "../../src/ui/keybindings";

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
    const keys = Object.entries(preset).filter(([action]) => action !== "rebaseScope").flatMap(([, keys]) => keys);
    expect(new Set(keys).size).toBe(keys.length);
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
    expect(await readKeybindings(path)).toEqual({ preset: "jjui", custom: false, bindings: defaultBindings });
    expect(await readKeybindings(path, "legacy")).toEqual({ preset: "legacy", custom: false, bindings: legacyBindings });
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
  expect(loadKeybindings({ bindings: {} })).toEqual({ preset: "jjui", custom: false, bindings: jjuiBindings });
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
