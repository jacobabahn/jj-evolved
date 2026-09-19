import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionForKey, keyLabel, defaultBindings, parseKeybindings, readKeybindings } from "../../src/ui/keybindings";

test("defaults and overrides preserve independent arrays and support unbinding", () => {
  expect(parseKeybindings({ bindings: {} })).toEqual(defaultBindings);
  const custom = parseKeybindings({ bindings: { down: ["x"], help: [] } });
  expect(custom.down).toEqual(["x"]);
  expect(custom.help).toEqual([]);
  custom.up.push("y");
  expect(defaultBindings.up).toEqual(["k", "up"]);
});

test("rejects malformed configuration, unknown actions, terminal aliases and collisions", () => {
  for (const config of [null, [], {}, { bindings: [] }, { extra: true, bindings: {} }, { bindings: { unknown: [] } }, { bindings: { help: "h" } }, { bindings: { help: ["ctrl+c"] } }, { bindings: { help: ["ctrl+m"] } }, { bindings: { help: ["F13"] } }]) {
    expect(() => parseKeybindings(config)).toThrow();
  }
  expect(() => parseKeybindings({ bindings: { help: ["j"] } })).toThrow("conflicts between down and help");
  expect(parseKeybindings({ bindings: { help: ["j"], down: ["h"] } }).help).toEqual(["j"]);
});

test("matching separates control, shifted and modified keys", () => {
  const event = { name: "f", sequence: "f", ctrl: false, shift: false, meta: false, option: false };
  expect(actionForKey(defaultBindings, event)).toBe("files");
  expect(actionForKey(defaultBindings, { ...event, ctrl: true })).toBe("search");
  expect(actionForKey(defaultBindings, { ...event, meta: true })).toBeUndefined();
  expect(actionForKey(defaultBindings, { ...event, name: "r", sequence: "R", shift: true })).toBe("rebase");
});

test("missing configuration uses defaults and invalid files report their path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jj-evolved-keys-"));
  const path = join(directory, "keybindings.json");
  try {
    expect(await readKeybindings(path)).toEqual(defaultBindings);
    await writeFile(path, '{"bindings":{"help":["h"]}}');
    expect((await readKeybindings(path)).help).toEqual(["h"]);
    await writeFile(path, "not json");
    await expect(readKeybindings(path)).rejects.toThrow(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("primary footer labels preserve a literal slash", () => {
  const bindings = parseKeybindings({ bindings: { down: ["/", "down"], filter: ["x"] } });
  expect(keyLabel(bindings, "down", true)).toBe("/");
});
