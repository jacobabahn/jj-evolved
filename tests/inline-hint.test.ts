import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";

// The cursor starts on the source, which cannot be its own destination.
for (const [key, verb] of [["r", "Rebase"], ["S", "Squash"]] as const) {
  test(`${verb.toLowerCase()} asks for a destination until the cursor leaves the source`, () => withUiFixture(`inline-hint-${key}`, async ui => {
    await ui.until("Empty change.");
    const [source] = (await ui.repo.snapshot("@")).revisions;
    const [parent] = (await ui.repo.snapshot("@-")).revisions;
    ui.key(key);
    await ui.until(`${verb} from ● ${source!.changeId.slice(0, 8)} → choose a destination`);
    ui.key("j");
    await ui.until(`${verb} from ● ${source!.changeId.slice(0, 8)} → ${parent!.changeId.slice(0, 8)}`);
    ui.key("k");
    await ui.until("→ choose a destination");
  }, { theme: "dark" }), 15_000);
}
