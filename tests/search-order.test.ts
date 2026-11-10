import { expect, test } from "bun:test";
import { withUiFixture } from "../tooling/ui";

// jj lists revisions without a graph in a different order from the graph's rows: here "find beta" comes before
// "find alpha" without the graph, but below it on screen. Stepping and the count follow the screen.
test("search steps through matches in the order they appear in the graph", () => withUiFixture("search-order", async ui => {
  for (const args of [["new", "feature", "-m", "find alpha"], ["new", "-m", "alpha tip"], ["bookmark", "create", "alpha"],
    ["new", "feature", "-m", "find beta"], ["new", "alpha", "-m", "top"]]) await ui.f.jj(...args);
  const noGraph = await ui.repo.navigationRevisions("all()");
  const order = (name: string) => noGraph.findIndex(item => item.description.startsWith(name));
  expect(order("find beta")).toBeLessThan(order("find alpha"));
  ui.key("r", { ctrl: true });
  await ui.until("top");
  await ui.settled();
  const screen = () => ui.screen.captureCharFrame();
  expect(screen().indexOf("find alpha")).toBeLessThan(screen().indexOf("find beta"));
  const selectedRow = () => screen().split("\n").filter(line => line.includes("▌")).join("\n");
  ui.key("/");
  await ui.until("Type to search");
  await ui.type("find");
  await ui.until("1 of 2");
  ui.key("RETURN");
  await ui.until("clear search");
  await ui.settled();
  expect(selectedRow()).toContain("find alpha");
  ui.key("'");
  await ui.until("2 of 2");
  await ui.settled();
  expect(selectedRow()).toContain("find beta");
  ui.key("'");
  await ui.until("1 of 2");
  await ui.settled();
  expect(selectedRow()).toContain("find alpha");
  ui.key('"');
  await ui.until("2 of 2");
  await ui.settled();
  expect(selectedRow()).toContain("find beta");
  // A refresh reloads the kept search, which comes back in jj's order again.
  await ui.f.jj("bookmark", "create", "external", "-r", "alpha");
  ui.screen.renderer.emit("focus");
  await ui.until("external");
  await ui.settled();
  ui.key("'");
  await ui.until("1 of 2");
  await ui.settled();
  expect(selectedRow()).toContain("find alpha");
}, { theme: "dark" }), 15_000);

// Stepping to a match beyond the loaded 200 revisions opens a context view around it. The order must not be taken from
// that view, or the next step would put the revealed match first and loop between two matches.
test("search keeps its order when a match beyond the loaded graph is revealed", () => withUiFixture("search-order-beyond", async ui => {
  const steps: string[][] = [["new", "-m", "needle O1"]];
  for (let i = 0; i < 45; i++) steps.push(["new", "-m", `fill a${i}`]);
  steps.push(["new", "-m", "needle O2"]);
  for (let i = 0; i < 205; i++) steps.push(["new", "-m", `fill b${i}`]);
  steps.push(["new", "-m", "needle N1"], ["new", "-m", "fill c1"], ["new", "-m", "needle N2"], ["new", "-m", "top"]);
  for (const args of steps) await ui.f.jj(...args);
  ui.key("r", { ctrl: true });
  await ui.until("top");
  await ui.settled();
  const screen = () => ui.screen.captureCharFrame();
  const selected = () => screen().split("\n").filter(line => line.includes("▌")).join(" ").match(/needle \w+/)?.[0];
  ui.key("/");
  await ui.until("Type to search");
  await ui.type("needle");
  await ui.until("1 of 4");
  ui.key("RETURN");
  await ui.until("clear search");
  await ui.settled();
  const visited = [`${selected()} ${screen().match(/\d of 4/)?.[0]}`];
  for (let step = 0; step < 4; step++) {
    ui.key("'");
    await ui.until(`${(step + 1) % 4 + 1} of 4`);
    await ui.settled();
    visited.push(`${selected()} ${screen().match(/\d of 4/)?.[0]}`);
  }
  expect(visited).toEqual(["needle N2 1 of 4", "needle N1 2 of 4", "needle O2 3 of 4", "needle O1 4 of 4", "needle N2 1 of 4"]);
}, { theme: "dark" }), 120_000);
