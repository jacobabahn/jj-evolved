import { expect, test } from "bun:test";
import { catchUp, jjCommand, metrics, parseJjLog, summary, trimCast } from "../tooling/terminal-compare";
import { terminalScenarios } from "../tooling/terminal-scenarios";

test("names jj subcommands after global flags and their values", () => {
  expect(jjCommand("--no-pager --color=never --ignore-working-copy --at-op=@ diff --revision abc --git --")).toBe("diff");
  expect(jjCommand("--no-pager --color never --at-op 1234 op log --no-graph --limit 1 -T id")).toBe("op log");
  expect(jjCommand("--no-pager log --config ui.log-word-wrap=false --limit 200 --revisions all()")).toBe("log");
  expect(jjCommand("--no-pager --ignore-working-copy --at-op=@ bookmark list --all-remotes")).toBe("bookmark list");
  expect(jjCommand("--no-pager -R /repo status")).toBe("status");
  expect(jjCommand("--version")).toBe("(none)");
});

test("parses the PATH shim log, including comma decimal separators", () => {
  expect(parseJjLog("1790000000.250000\tstatus \n1790000001,5\tdiff -r x \n")).toEqual([
    { at: 1790000000250, args: "status " }, { at: 1790000001500, args: "diff -r x " },
  ]);
});

test("catch-up ends at the first change followed by a quiet period", () => {
  expect(catchUp([], 1000, 5000)).toBe(0);
  expect(catchUp([900, 950], 1000, 5000)).toBe(0);
  expect(catchUp([1010], 1000, 5000)).toBe(10);
  // A burst of late renders, then quiet: catch-up is the last render of the burst.
  expect(catchUp([1050, 1100, 1200, 1250], 1000, 5000)).toBe(250);
  // A later unrelated change after a quiet gap does not extend catch-up.
  expect(catchUp([1050, 3000], 1000, 5000)).toBe(50);
  // Changes that never settle before the next burst count up to the last one.
  expect(catchUp([1100, 1200, 1300], 1000, 1350)).toBe(300);
});

test("trims tmux's exit output and trailing screen clears from a cast", () => {
  const cast = [
    JSON.stringify({ version: 2, width: 10, height: 2 }),
    JSON.stringify([0.1, "o", "app"]),
    JSON.stringify([0.2, "o", "\u001b[H\u001b[2J"]),
    JSON.stringify([0.3, "o", "[exited]"]),
    JSON.stringify([0.4, "o", "shell"]),
  ].join("\n");
  const lines = trimCast(cast).trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]!)[2]).toBe("app");
  expect(trimCast(cast.split("\n").slice(0, 2).join("\n")).trim().split("\n")).toHaveLength(2);
});

test("metrics group jj processes by command and attribute them to bursts", () => {
  const calls = [{ at: 100, args: "status" }, { at: 1100, args: "diff -r a" }, { at: 1200, args: "diff -r b" }, { at: 2500, args: "--at-op=@ op log" }];
  const bursts = [{ label: "j", start: 1000, lastKey: 1150, keys: 2 }, { label: "k", start: 2000, lastKey: 2000, keys: 1 }];
  const samples = [{ at: 500, text: "start" }, { at: 1180, text: "Loading diff…" }, { at: 1300, text: "done" }];
  const result = metrics("main", 400, 50, calls, bursts, samples, 3000, ["Loading diff"]);
  expect(result.jj).toEqual({ total: 4, byCommand: { status: 1, diff: 2, "op log": 1 } });
  expect(result.bursts).toEqual([{ label: "j", keys: 2, catchUpMs: 150, jj: 2 }, { label: "k", keys: 1, catchUpMs: 0, jj: 1 }]);
  expect(result.watched).toEqual({ "Loading diff": 1 });
  expect(result.idleJj).toBe(1);
  const table = summary(terminalScenarios[0]!, result, { ...result, label: "branch" }, true);
  expect(table).toContain("| Metric | Before (main) | After (branch) |");
  expect(table).toContain("| Catch-up after j | 150 ms | 150 ms |");
  expect(table).toContain("| jj processes while idle before the first key | 1 | 1 |");
  expect(table).toContain("`jj diff` | 2 | 2 |");
  expect(table).toContain("![Before and after](compare.gif)");
});

test("scenarios have unique names and send at least one key", () => {
  expect(new Set(terminalScenarios.map(scenario => scenario.name)).size).toBe(terminalScenarios.length);
  for (const scenario of terminalScenarios) expect(scenario.steps.some(step => "keys" in step && step.keys.length > 0)).toBe(true);
});
