import { createCliRenderer } from "@opentui/core";
import { createApp } from "./app";
import { Repository } from "./repository";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Usage: bun start [repository-path]\n\nA keyboard-driven Jujutsu workspace. Requires jj on PATH.\nPress ? inside the app for keyboard help.\n");
} else if (args.length > 1 || args[0]?.startsWith("-")) {
  process.stderr.write("Usage: bun start [repository-path]\n");
  process.exitCode = 1;
} else {
  try {
    const repository = await Repository.open(args[0] ?? process.cwd());
    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    try {
      const app = createApp(renderer, repository);
      await app.start();
    } catch (error) {
      renderer.destroy();
      throw error;
    }
  } catch (error) {
    process.stderr.write(`jj-evolved: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
