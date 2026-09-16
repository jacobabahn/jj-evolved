import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mutation } from "./model";
import { mutationArgs } from "./mutation";
import { run } from "./jj-process";

// JJ invokes the description editor twice with --editor, even for an unnamed
// source. Supply both reviewed descriptions inside that single transaction so
// a failure cannot leave a half-completed split and undo restores both parts.
export async function runSplit(root: string, action: Extract<Mutation, { kind: "split" }>) {
  if (action.secondDescription === action.revision.description) {
    await run(root, mutationArgs(action));
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "jj-evolved-split-"));
  try {
    const editor = join(directory, "editor.ts");
    const messages = join(directory, "messages.json");
    await Bun.write(messages, JSON.stringify([action.description, action.secondDescription]));
    await Bun.write(editor, `
const messages = Bun.file(process.argv[2]);
const remaining = await messages.json();
if (!remaining.length) throw new Error("Unexpected split editor invocation");
await Bun.write(process.argv[3], remaining.shift());
await Bun.write(messages, JSON.stringify(remaining));
`);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const args = mutationArgs(action);
    args.splice(args.indexOf("--"), 0, "--editor");
    await run(root, args, false, { JJ_EDITOR: [process.execPath, editor, messages].map(quote).join(" ") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
