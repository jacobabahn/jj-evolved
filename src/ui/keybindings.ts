import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyEvent } from "@opentui/core";

// Default keys follow jjui (https://github.com/idursun/jjui) so muscle memory carries over.
export const jjuiBindings = {
  down: ["j", "down"], up: ["k", "up"], focus: ["tab"],
  pageUp: ["pageup"], pageDown: ["pagedown"],
  previewUp: ["ctrl+p"], previewDown: ["ctrl+n"], previewHalfUp: ["ctrl+u"], previewHalfDown: ["ctrl+d"],
  status: ["w"], refresh: ["ctrl+r"], loadMore: ["ctrl+l"],
  filter: ["L"], search: ["/"], nextMatch: ["'"], previousMatch: ['"'],
  workingCopy: ["@"], parent: ["["], child: ["]"], return: ["ctrl+o"], clearSearch: ["escape"],
  describe: ["return"], describeExternal: ["D"], edit: ["e"], rebase: ["r"], squash: ["S"],
  abandon: ["a"], absorb: ["A"], split: ["s"], evolution: ["v"],
  new: ["n"], actions: ["space"], bookmarks: ["b"], git: ["g"], operations: ["o"], undo: ["u"], files: ["l", "right"],
  diff: ["d"], togglePreview: ["p"], theme: ["t"], help: ["?"], lastError: ["ctrl+e"], quit: ["q"],
} satisfies Record<string, string[]>;
export type Action = keyof typeof jjuiBindings;
export type Keybindings = Record<Action, string[]>;

// The keys jj-evolved shipped before adopting jjui's defaults.
export const legacyBindings: Keybindings = {
  ...jjuiBindings,
  previewUp: [], previewDown: [], previewHalfUp: ["ctrl+u"], previewHalfDown: ["ctrl+d"],
  status: ["s"], refresh: ["r"], loadMore: ["L"],
  filter: ["/"], search: ["ctrl+f"], nextMatch: ["ctrl+n"], previousMatch: ["ctrl+p"],
  describe: ["d"], describeExternal: [], rebase: ["R"], abandon: [], absorb: ["a"], split: [], git: [], files: ["f"], diff: ["return"],
};
export const presets = { jjui: jjuiBindings, legacy: legacyBindings } as const;
export type Preset = keyof typeof presets;
export const defaultBindings: Keybindings = jjuiBindings;
const namedKeys = new Set(["up", "down", "left", "right", "tab", "pageup", "pagedown", "home", "end", "space", "escape", "return", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);

export function parseKeybindings(value: unknown): Keybindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object with a bindings object.");
  const config = value as Record<string, unknown>;
  for (const field of Object.keys(config)) if (field !== "bindings" && field !== "preset") throw new Error(`Unknown configuration field: ${field}`);
  const preset = config.preset ?? "jjui";
  if (typeof preset !== "string" || !Object.hasOwn(presets, preset)) throw new Error(`Unknown preset ${JSON.stringify(preset)}. Use one of: ${Object.keys(presets).join(", ")}.`);
  const bindings = config.bindings ?? {};
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new Error("Expected a bindings object.");
  const result = structuredClone(presets[preset as Preset]) as Keybindings;
  for (const [action, keys] of Object.entries(bindings)) {
    if (!Object.hasOwn(jjuiBindings, action)) throw new Error(`Unknown keybinding action: ${action}`);
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
  return (firstOnly ? bindings[action].slice(0, 1) : bindings[action]).map(key => key.startsWith("ctrl+") ? `^${key.slice(5).toUpperCase()}` : ({ space: "Space", return: "Enter", escape: "Esc", tab: "Tab", pageup: "PgUp", pagedown: "PgDn", left: "Left", right: "Right" }[key] ?? key)).join("/") || "unbound";
}
