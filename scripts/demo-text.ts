import { keyLabel, type Action, type Keybindings } from "../src/ui/keybindings";

/** The demo repository's instructions, naming the keys of `bindings` so they stay right when the defaults change. */
export function demoText(bindings: Keybindings) {
  const key = (action: Action) => keyLabel(bindings, action, true);
  const controls = `# Controls\n\n${key("down")}/${key("up")}: browse changes\n${key("rebase")}: rebase a change\n${key("squash")}: squash changes\n`;
  return {
    controls,
    controlsWithDrag: `${controls}\nDrag a change onto another change to preview a rebase.\nDrag a bookmark label to move just that bookmark.\n`,
    multiline: `Try multiline descriptions\n\nPress ${key("describe")} on this change to edit its description in the app.\nEnter adds a new line; ${key("saveDescription")} saves and Esc cancels.\n\nThis final paragraph lets you check that blank lines are preserved.`,
    descriptionsDoc: `# Multiline descriptions\n\nPress ${key("describe")} to edit a description in the app. Enter adds a new line,\n${key("saveDescription")} saves and Esc cancels. ${key("describeExternal")}, or ${key("actions")} → Describe in editor, opens\nyour configured editor instead.\n`,
  };
}
