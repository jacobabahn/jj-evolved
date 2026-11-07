import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";
import { scrollBoxMisfits } from "./scroll-fit";

// The rebase and squash form previews in a scroll box built like the help overlay's, so its text had the same
// fraction-of-a-cell overflow: the destination prompt and the result trees ran one column past the viewport.
for (const [width, height] of [[80, 24], [100, 30]]) {
  test(`rebase form preview fits its viewport at ${width}x${height}`, () => withUiFixture(`history-fit-${width}`, async ui => {
    await ui.until("Empty change.");
    ui.key(" ");
    ui.choose("Rebase");
    await ui.until("Destination: Choose a revision");
    expect(scrollBoxMisfits(ui, "history-preview")).toEqual([]);
    ui.key("RETURN");
    await ui.until("j/k choose");
    ui.key("j");
    ui.key("RETURN");
    await ui.until("Preview ready");
    await ui.settled();
    expect(scrollBoxMisfits(ui, "history-preview")).toEqual([]);
  }, { width, height }));
}
