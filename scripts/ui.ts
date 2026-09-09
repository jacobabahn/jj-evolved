import { resolve } from "node:path";
import { scenarios } from "../tooling/scenarios";
import { withUiFixture } from "../tooling/ui";
import { writeRecording, type Recording } from "../tooling/recording";

const [command = "gallery", name, destination, ...extra] = process.argv.slice(2);
const usage = "Usage: bun run ui [list | gallery [output-directory] | record <scenario> [output-directory]]";
try {
  if (command === "list") {
    if (name || destination || extra.length) throw new Error(usage);
    for (const scenario of scenarios) console.log(`${scenario.name.padEnd(10)} ${scenario.title}`);
  } else if (command === "gallery" || command === "record") {
    if (extra.length || (command === "gallery" && destination)) throw new Error(usage);
    const selected = command === "gallery" ? scenarios : scenarios.filter(scenario => scenario.name === name);
    if (!selected.length) throw new Error(`Unknown scenario ${JSON.stringify(name)}. Run bun run ui list.`);
    const directory = resolve(command === "gallery" ? name ?? "artifacts/ui/gallery" : destination ?? `artifacts/ui/${name}`);
    const recordings: Recording[] = [];
    for (const scenario of selected) {
      recordings.push(await withUiFixture(scenario.name, async ui => {
        await scenario.run(ui);
        return ui.recording.snapshot(scenario.title);
      }, { theme: "dark" }));
      console.log(`Recorded ${scenario.name}`);
    }
    console.log(`Open ${await writeRecording(directory, recordings)}`);
  } else if (command === "--help" || command === "-h") {
    console.log(usage);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
