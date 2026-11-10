import { keyLabel, type Action, type Keybindings, type Scope } from "../src/ui/keybindings";

/**
 * The demo repository's instructions, naming the keys the app will use, so they match whatever preset or overrides
 * are configured. An action with no key is named by its action-menu entry instead.
 */
export function demoText(scopes: Record<Scope, Keybindings>) {
  const bound = (scope: Scope, action: Action) => {
    const label = keyLabel(scopes[scope], action, true);
    return label === "unbound" ? undefined : label;
  };
  const key = (action: Action) => bound("revisions", action);
  const menu = (entry: string) => key("actions") ? `${key("actions")} → ${entry}` : `the action menu's ${entry}`;
  const describe = key("describe") ?? menu("Describe");
  const save = bound("prompt", "saveDescription") ?? "the save key";
  const browse = key("down") && key("up") ? [`${key("down")}/${key("up")}: browse changes`] : [];
  const controls = `# Controls\n\n${[...browse, `${key("rebase") ?? menu("Rebase")}: rebase a change`, `${key("squash") ?? menu("Squash")}: squash changes`].join("\n")}\n`;
  const external = key("describeExternal") ? `${key("describeExternal")}, or ${menu("Describe in editor")},` : menu("Describe in editor");
  return {
    controls,
    controlsWithDrag: `${controls}\nDrag a change onto another change to preview a rebase.\nDrag a bookmark label to move just that bookmark.\n`,
    multiline: `Try multiline descriptions\n\nPress ${describe} on this change to edit its description in the app.\nEnter adds a new line; ${save} saves and Esc cancels.\n\nThis final paragraph lets you check that blank lines are preserved.`,
    descriptionsDoc: `# Multiline descriptions\n\nPress ${describe} to edit a description in the app. Enter adds a new line,\n${save} saves and Esc cancels. ${external} opens\nyour configured editor instead.\n`,
  };
}
