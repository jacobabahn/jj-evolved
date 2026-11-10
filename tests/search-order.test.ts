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
}, { theme: "dark" }), 15_000);
