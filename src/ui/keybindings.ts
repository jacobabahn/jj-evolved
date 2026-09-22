import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyEvent } from "@opentui/core";

export const defaultBindings = {
  down: ["j", "down"], up: ["k", "up"], focus: ["tab"],
  pageUp: ["pageup"], pageDown: ["pagedown"], status: ["s"], refresh: ["r"], loadMore: ["L"],
  filter: ["/"], search: ["ctrl+f"], nextMatch: ["ctrl+n"], previousMatch: ["ctrl+p"],
  workingCopy: ["@"], parent: ["["], child: ["]"], return: ["ctrl+o"], clearSearch: ["escape"],
  describe: ["d"], edit: ["e"], rebase: ["R"], squash: ["S"], absorb: ["a"], evolution: ["v"],
  new: ["n"], actions: ["space"], bookmarks: ["b"], operations: ["o"], undo: ["u"], files: ["f"],
  preview: ["return"], togglePreview: ["p"], theme: ["t"], help: ["?"], quit: ["q"],
} satisfies Record<string, string[]>;
export type Action = keyof typeof defaultBindings;
export type Keybindings = Record<Action, string[]>;
const namedKeys = new Set(["up", "down", "left", "right", "tab", "pageup", "pagedown", "home", "end", "space", "escape", "return", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);

export function parseKeybindings(value: unknown): Keybindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object with a bindings object.");
  const config = value as Record<string, unknown>;
  for (const field of Object.keys(config)) if (field !== "bindings") throw new Error(`Unknown configuration field: ${field}`);
  if (!config.bindings || typeof config.bindings !== "object" || Array.isArray(config.bindings)) throw new Error("Expected a bindings object.");
  const result = structuredClone(defaultBindings) as Keybindings;
  for (const [action, keys] of Object.entries(config.bindings)) {
    if (!Object.hasOwn(defaultBindings, action)) throw new Error(`Unknown keybinding action: ${action}`);
    if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error(`Keybinding ${action} must be an array of keys.`);
    for (const key of keys) {
      if (!(namedKeys.has(key) || /^[!-~]$/.test(key) || /^ctrl\+[a-z]$/.test(key))) throw new Error(`Invalid key ${JSON.stringify(key)} for ${action}. Use a printable ASCII character, named key, or ctrl+a through ctrl+z.`);
      if (["ctrl+c", "ctrl+i", "ctrl+j", "ctrl+m", "ctrl+h", "ctrl+z"].includes(key)) throw new Error(`Key ${key} is reserved by the terminal; use a named key where applicable.`);
    }
    result[action as Action] = [...keys];
  }
  const owners = new Map<string, Action>();
  for (const [action, keys] of Object.entries(result) as [Action, string[]][]) {
    for (const key of keys) {
      const owner = owners.get(key);
      if (owner) throw new Error(`Key ${key} conflicts between ${owner} and ${action}. Override both actions to resolve the conflict.`);
      owners.set(key, action);
    }
  }
  return result;
}

export function keybindingsPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jj-evolved", "keybindings.json");
}
export async function readKeybindings(path = keybindingsPath()): Promise<Keybindings> {
  try { return parseKeybindings(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return structuredClone(defaultBindings);
    throw new Error(`Cannot load keybindings from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function actionForKey(bindings: Keybindings, key: Pick<KeyEvent, "name" | "sequence" | "ctrl" | "shift" | "meta" | "option">): Action | undefined {
  if (key.meta || key.option) return;
  let name = key.ctrl ? `ctrl+${key.name.toLowerCase()}` : key.name;
  if (!key.ctrl && key.sequence.length === 1 && /^[!-~]$/.test(key.sequence)) name = key.sequence;
  else if (!key.ctrl && key.shift && /^[a-z]$/.test(name)) name = name.toUpperCase();
  else if (!key.ctrl && key.shift) return;
  return (Object.keys(bindings) as Action[]).find(action => bindings[action].includes(name));
}
export function keyLabel(bindings: Keybindings, action: Action, firstOnly = false) {
  return (firstOnly ? bindings[action].slice(0, 1) : bindings[action]).map(key => key.startsWith("ctrl+") ? `^${key.slice(5).toUpperCase()}` : ({ space: "Space", return: "Enter", escape: "Esc", tab: "Tab", pageup: "PgUp", pagedown: "PgDn" }[key] ?? key)).join("/") || "unbound";
}
