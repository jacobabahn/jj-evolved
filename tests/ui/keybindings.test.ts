import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionForKey, keyLabel, defaultBindings, jjuiBindings, legacyBindings, parseKeybindings, readKeybindings } from "../../src/ui/keybindings";

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
    const keys = Object.values(preset).flat();
    expect(new Set(keys).size).toBe(keys.length);
  }
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
});

test("missing configuration uses defaults and invalid files report their path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jj-evolved-keys-"));
  const path = join(directory, "keybindings.json");
  try {
    expect(await readKeybindings(path)).toEqual(defaultBindings);
    await writeFile(path, '{"bindings":{"help":["h"]}}');
    expect((await readKeybindings(path)).help).toEqual(["h"]);
    await writeFile(path, '{"preset":"legacy"}');
    expect((await readKeybindings(path)).describe).toEqual(["d"]);
    await writeFile(path, "not json");
    await expect(readKeybindings(path)).rejects.toThrow(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("labels name control, named and literal keys", () => {
  const bindings = parseKeybindings({ bindings: { down: ["/", "down"], search: ["x"] } });
  expect(keyLabel(bindings, "down", true)).toBe("/");
  expect(keyLabel(defaultBindings, "refresh")).toBe("^R");
  expect(keyLabel(defaultBindings, "files")).toBe("l/Right");
  expect(keyLabel(defaultBindings, "describe")).toBe("Enter");
  expect(keyLabel(parseKeybindings({ bindings: { help: [] } }), "help")).toBe("unbound");
});
