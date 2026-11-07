import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyEvent } from "@opentui/core";

// Default keys follow jjui (https://github.com/idursun/jjui) so muscle memory carries over.
// A binding is one key, or several separated by spaces ("g f") that are pressed one after another.
export const jjuiBindings = {
  down: ["j", "down"], up: ["k", "up"], focus: ["tab"],
  pageUp: ["pageup"], pageDown: ["pagedown"],
  previewUp: ["ctrl+p"], previewDown: ["ctrl+n"], previewHalfUp: ["ctrl+u"], previewHalfDown: ["ctrl+d"],
  status: ["w"], refresh: ["ctrl+r"], loadMore: ["ctrl+l"],
  filter: ["L"], search: ["/"], nextMatch: ["'"], previousMatch: ['"'],
  workingCopy: ["@"], parent: ["["], child: ["]"], return: ["ctrl+o"], clearSearch: ["escape"],
  describe: ["return"], describeExternal: ["D"], edit: ["e"], rebase: ["r"], squash: ["S"], rebaseScope: ["tab"],
  abandon: ["a"], absorb: ["A"], split: ["s"], evolution: ["v"],
  new: ["n"], actions: ["space"], bookmarks: ["b"], setBookmark: ["B"], git: ["g"], publish: [], operations: ["o"], undo: ["u"], files: ["l", "right"],
  diff: ["d"], togglePreview: ["p"], theme: ["t"], help: ["?"], lastError: ["ctrl+e"], quit: ["q"],
  back: ["h", "left"], nextCompletion: ["tab", "ctrl+n"], previousCompletion: ["ctrl+p"], saveDescription: ["ctrl+s", "ctrl+d"],
} satisfies Record<string, string[]>;
export type Action = keyof typeof jjuiBindings;
export type Keybindings = Record<Action, string[]>;

/**
 * Where a binding applies. Each scope listens only to its own actions, so one key can do different things in
 * different places (Ctrl+N scrolls the preview while browsing and picks the next revset suggestion in a prompt).
 */
export const scopeActions = {
  revisions: ["down", "up", "focus", "pageUp", "pageDown", "previewUp", "previewDown", "previewHalfUp", "previewHalfDown",
    "status", "refresh", "loadMore", "filter", "search", "nextMatch", "previousMatch", "workingCopy", "parent", "child", "return",
    "clearSearch", "describe", "describeExternal", "edit", "rebase", "squash", "abandon", "absorb", "split", "evolution", "new",
    "actions", "bookmarks", "setBookmark", "git", "publish", "operations", "undo", "files", "diff", "togglePreview", "theme",
    "help", "lastError", "quit"],
  files: ["down", "up", "focus", "pageUp", "pageDown", "previewUp", "previewDown", "previewHalfUp", "previewHalfDown", "togglePreview", "files", "back", "help", "quit"],
  // Choosing an inline rebase or squash destination in the graph.
  destination: ["down", "up", "pageUp", "pageDown", "search", "rebaseScope", "loadMore", "togglePreview"],
  // Action menus, pickers, the theme chooser, the keyboard reference, and the rebase and squash form.
  menu: ["down", "up", "back", "help"],
  // Text prompts: the revset filter, bookmark names, the description editor and quick inputs.
  prompt: ["nextCompletion", "previousCompletion", "saveDescription"],
} as const satisfies Record<string, readonly Action[]>;
export type Scope = keyof typeof scopeActions;
export const scopeNames = Object.keys(scopeActions) as Scope[];
const scopeTitles: Record<Scope, string> = { revisions: "revision list", files: "file browser", destination: "destination choice", menu: "menus", prompt: "text prompts" };
const actionOrder = Object.keys(jjuiBindings) as Action[];
const inScope = (scope: Scope) => actionOrder.filter(action => (scopeActions[scope] as readonly Action[]).includes(action));
// Kept for callers that ask which actions stay live while choosing an inline destination.
export const inlineActions: Action[] = [...scopeActions.destination];

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
// Control keys the text inputs use for editing: line start and end, cursor moves, and deleting words or lines.
const editingKeys = new Set(["ctrl+a", "ctrl+b", "ctrl+e", "ctrl+f", "ctrl+k", "ctrl+u", "ctrl+w"]);
const maxSequence = 3;

export const presetNames = Object.keys(presets) as Preset[];
/** The global table, and for each scope the table that applies there (the global one with that scope's overrides). */
export interface Keymap { bindings: Keybindings; scopes: Record<Scope, Keybindings> }
export type KeybindingConfig = Keymap & { preset: Preset; custom: boolean };

export function parsePreset(value: unknown, source?: string): Preset {
  if (typeof value === "string" && Object.hasOwn(presets, value)) return value as Preset;
  throw new Error(`Unknown preset ${JSON.stringify(value)}${source ? ` from ${source}` : ""}. Use one of: ${presetNames.join(", ")}.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parseKeys(action: string, keys: unknown, where: string): string[] {
  if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error(`Keybinding ${action}${where} must be an array of keys.`);
  for (const binding of keys as string[]) {
    const parts = binding.split(" ");
    if (parts.length > maxSequence) throw new Error(`Key sequence ${JSON.stringify(binding)} for ${action} is too long; use at most ${maxSequence} keys.`);
    for (const key of parts) {
      if (!(namedKeys.has(key) || /^[!-~]$/.test(key) || /^ctrl\+[a-z]$/.test(key))) {
        throw new Error(`Invalid key ${JSON.stringify(key)} for ${action}. Use a printable ASCII character, named key, or ctrl+a through ctrl+z; separate the keys of a sequence with single spaces.`);
      }
      if (["ctrl+c", "ctrl+i", "ctrl+j", "ctrl+m", "ctrl+h", "ctrl+z"].includes(key)) throw new Error(`Key ${key} is reserved by the terminal; use a named key where applicable.`);
      // Escape cancels a sequence that has started, so it cannot be part of one.
      if (key === "escape" && parts.length > 1) throw new Error(`Key sequence ${JSON.stringify(binding)} for ${action} cannot contain escape, which cancels a sequence.`);
    }
  }
  return [...keys as string[]];
}
/** Keys a scope keeps for itself, whatever the configuration says. */
function checkReserved(scope: Scope, table: Keybindings) {
  for (const action of scopeActions[scope]) for (const binding of table[action]) for (const key of binding.split(" ")) {
    if ((scope === "destination" || scope === "menu") && (key === "return" || key === "escape")) {
      throw new Error(scope === "destination"
        ? `Key ${key} is reserved for inline destination controls; choose another key for ${action}.`
        : `Key ${key} is reserved in menus, where Enter chooses and Escape goes back; choose another key for ${action}.`);
    }
    if (scope === "prompt" && !((/^ctrl\+[a-z]$/.test(key) && !editingKeys.has(key)) || key === "tab" || /^f\d+$/.test(key))) {
      throw new Error(`Key ${key} for ${action} would stop text prompts from accepting it; use tab, f1–f12, or a control key other than ${[...editingKeys].join(", ")}.`);
    }
  }
}
/**
 * back took over h and Left, which were fixed keys before they could be bound. Its default keys step aside for any
 * other action of the scope bound to them, so a configuration that put help on h keeps working.
 */
function yieldBack(scope: Scope, table: Keybindings): Keybindings {
  if (!(scopeActions[scope] as readonly Action[]).includes("back")) return table;
  const others = scopeActions[scope].filter(action => action !== "back").flatMap(action => table[action]);
  const back = table.back.filter(key => !others.some(binding => binding === key || binding.startsWith(key + " ")));
  return back.length === table.back.length ? table : { ...table, back };
}
/** Two actions of one scope may not share a key, and no binding may be the start of another, which would never run. */
function checkConflicts(scope: Scope, table: Keybindings) {
  const seen: [string, Action][] = [];
  for (const action of inScope(scope)) for (const binding of table[action]) {
    for (const [other, owner] of seen) {
      if (other === binding) throw new Error(`Key ${binding} conflicts between ${owner} and ${action} in the ${scopeTitles[scope]}. Override both actions to resolve the conflict.`);
      const [short, shortAction, long, longAction] = other.length < binding.length ? [other, owner, binding, action] : [binding, action, other, owner];
      if (long.startsWith(short + " ")) {
        throw new Error(`Key ${short} (${shortAction}) starts the sequence ${long} (${longAction}) in the ${scopeTitles[scope]}, so ${short} could never run ${shortAction} on its own. Override one of them.`);
      }
    }
    seen.push([binding, action]);
  }
}

// An explicit preset (CLI flag or environment) replaces the file's preset; file bindings still apply on top.
export function loadKeybindings(value: unknown, preset?: Preset): KeybindingConfig {
  if (!isObject(value)) throw new Error("Expected an object with a bindings object.");
  for (const field of Object.keys(value)) if (!["bindings", "preset", "scopes"].includes(field)) throw new Error(`Unknown configuration field: ${field}`);
  const filePreset = value.preset === undefined ? "jjui" : parsePreset(value.preset);
  const chosen = preset ?? filePreset;
  const bindings = value.bindings ?? {};
  if (!isObject(bindings)) throw new Error("Expected a bindings object.");
  const result = structuredClone(presets[chosen]) as Keybindings;
  for (const [action, keys] of Object.entries(bindings)) {
    if (!Object.hasOwn(jjuiBindings, action)) throw new Error(`Unknown keybinding action: ${action}`);
    result[action as Action] = parseKeys(action, keys, "");
  }
  const scoped = value.scopes ?? {};
  if (!isObject(scoped)) throw new Error("Expected a scopes object mapping scope names to bindings.");
  let overrides = Object.keys(bindings).length;
  const scopes = {} as Record<Scope, Keybindings>;
  const explicitBack = new Set<Scope>(Object.hasOwn(bindings, "back") ? scopeNames : []);
  for (const scope of scopeNames) scopes[scope] = structuredClone(result);
  for (const [scope, table] of Object.entries(scoped)) {
    if (!Object.hasOwn(scopeActions, scope)) throw new Error(`Unknown keybinding scope: ${scope}. Use one of: ${scopeNames.join(", ")}.`);
    if (!isObject(table)) throw new Error(`Scope ${scope} must be an object of bindings.`);
    for (const [action, keys] of Object.entries(table)) {
      if (!Object.hasOwn(jjuiBindings, action)) throw new Error(`Unknown keybinding action: ${action}`);
      if (!(scopeActions[scope as Scope] as readonly string[]).includes(action)) throw new Error(`Action ${action} does not apply in the ${scope} scope. Actions there: ${scopeActions[scope as Scope].join(", ")}.`);
      scopes[scope as Scope][action as Action] = parseKeys(action, keys, ` in ${scope}`);
      if (action === "back") explicitBack.add(scope as Scope);
      ++overrides;
    }
  }
  for (const scope of scopeNames) if (!explicitBack.has(scope)) scopes[scope] = yieldBack(scope, scopes[scope]);
  for (const scope of scopeNames) { checkReserved(scope, scopes[scope]); checkConflicts(scope, scopes[scope]); }
  return { preset: chosen, custom: overrides > 0, bindings: result, scopes };
}
export function parseKeybindings(value: unknown, preset?: Preset): Keybindings {
  return loadKeybindings(value, preset).bindings;
}
/** The keymap for a validated global table with no scope overrides. */
export function keymap(bindings: Keybindings): Keymap {
  return { bindings, scopes: Object.fromEntries(scopeNames.map(scope => [scope, yieldBack(scope, bindings)])) as Record<Scope, Keybindings> };
}

export function keybindingsPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jj-evolved", "keybindings.json");
}
export async function readKeybindings(path = keybindingsPath(), preset?: Preset): Promise<KeybindingConfig> {
  try { return loadKeybindings(JSON.parse(await readFile(path, "utf8")), preset); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return loadKeybindings({}, preset);
    throw new Error(`Cannot load keybindings from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type KeyPress = Pick<KeyEvent, "name" | "sequence" | "ctrl" | "shift" | "meta" | "option">;
/** The configuration name of a key press, or undefined for one no binding can name (Alt, Meta, shifted named keys). */
export function keyName(key: KeyPress): string | undefined {
  if (key.meta || key.option) return;
  let name = key.ctrl ? `ctrl+${key.name.toLowerCase()}` : key.name;
  if (!key.ctrl && key.sequence.length === 1 && /^[!-~]$/.test(key.sequence)) name = key.sequence;
  else if (!key.ctrl && key.shift && /^[a-z]$/.test(name)) name = name.toUpperCase();
  else if (!key.ctrl && key.shift) return;
  return name;
}
/** The action a single key press runs on its own, ignoring sequences. */
export function actionForKey(bindings: Keybindings, key: KeyPress, actions: readonly Action[] = scopeActions.revisions): Action | undefined {
  const name = keyName(key);
  return name === undefined ? undefined : actions.find(action => bindings[action].includes(name));
}

export type KeyResult =
  | { kind: "action"; action: Action }
  // The keys so far start at least one sequence; the next key decides.
  | { kind: "pending"; keys: string[] }
  // The keys started a sequence but the last one finished none.
  | { kind: "unbound"; keys: string[] }
  // Escape abandoned the keys typed so far.
  | { kind: "cancelled"; keys: string[] }
  | { kind: "none" };
/**
 * Matches key presses against a scope's bindings, one press at a time. A key that only starts a sequence runs
 * nothing until the sequence completes or breaks. `owner` identifies the prompt the keys went to; keys pressed
 * in another prompt start over.
 */
export class KeySequence {
  private pending: string[] = [];
  private owner: unknown;

  /** The keys typed so far toward a sequence in the prompt `owner`. */
  pendingIn(owner: unknown): readonly string[] { return owner === this.owner ? this.pending : []; }
  cancel(): string[] { const keys = this.pending; this.pending = []; return keys; }

  feed(table: Keybindings, actions: readonly Action[], key: KeyPress, owner?: unknown): KeyResult {
    if (owner !== this.owner) { this.pending = []; this.owner = owner; }
    const name = keyName(key);
    if (name === "escape" && this.pending.length) return { kind: "cancelled", keys: this.cancel() };
    if (name === undefined) return this.pending.length ? { kind: "unbound", keys: [...this.cancel(), key.name || key.sequence] } : { kind: "none" };
    const typed = [...this.pending, name], text = typed.join(" ");
    const action = actions.find(action => table[action].includes(text));
    if (action) { this.pending = []; return { kind: "action", action }; }
    if (actions.some(action => table[action].some(binding => binding.startsWith(text + " ")))) { this.pending = typed; return { kind: "pending", keys: typed }; }
    this.pending = [];
    return typed.length > 1 ? { kind: "unbound", keys: typed } : { kind: "none" };
  }

  /** For each binding the pending keys start, the key that comes next and the action the binding runs. */
  continuations(table: Keybindings, actions: readonly Action[]): [string, Action][] {
    const prefix = this.pending.join(" ") + " ";
    return actions.flatMap(action => table[action].filter(binding => binding.startsWith(prefix)).map(binding => [binding.slice(prefix.length), action] as [string, Action]));
  }
}

const keyNames: Record<string, string> = { space: "Space", return: "Enter", escape: "Esc", tab: "Tab", pageup: "PgUp", pagedown: "PgDn", left: "Left", right: "Right" };
/** How a binding (one key or a sequence) is written in help and the footer: ^R, Enter, "g f". */
export function bindingLabel(binding: string): string {
  return binding.split(" ").map(key => key.startsWith("ctrl+") ? `^${key.slice(5).toUpperCase()}` : keyNames[key] ?? key).join(" ");
}
export function keyLabel(bindings: Keybindings, action: Action, firstOnly = false) {
  return (firstOnly ? bindings[action].slice(0, 1) : bindings[action]).map(bindingLabel).join("/") || "unbound";
}
