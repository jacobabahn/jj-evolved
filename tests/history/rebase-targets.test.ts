import { expect, test } from "bun:test";
import { Repository } from "../../src/repository/repository";
import { mutationArgs } from "../../src/repository/mutation";
import type { RebaseMutation, RebaseTarget, Revision } from "../../src/repository/model";
import { fixture } from "../fixture";

// A (Initial feature) has children B and X; B is a branch point with children C and D. X moves; Y is X's child.
//   C  D
//    \ /
//     B   Y
//      \  |
//       \ X
//        \|
//         A
async function setup() {
  const f = await fixture();
  await f.jj("describe", "-m", "B");
  await f.jj("new", "-m", "C");
  await f.jj("new", "-m", "D", 'description(exact:"B\n")');
  await f.jj("new", "-m", "X", 'description(exact:"Initial feature\n")');
  await f.jj("new", "-m", "Y");
  const repo = await Repository.open(f.path);
  async function revision(name: string): Promise<Revision> {
    const item = (await repo.snapshot(`description(exact:${JSON.stringify(name + "\n")})`)).revisions[0];
    if (!item) throw new Error(`Missing revision: ${name}`);
    return item;
  }
  /** Each named revision's parents, by description. */
  async function parents(): Promise<Record<string, string>> {
    const out = await f.jj("log", "--no-graph", "-r", "all() ~ root()", "-T",
      'description.first_line() ++ ":" ++ parents.map(|p| coalesce(p.description().first_line(), "root")).join(",") ++ "\\n"');
    return Object.fromEntries(out.trim().split("\n").map(line => line.split(":") as [string, string]));
  }
  return { ...f, repo, revision, parents };
}

const initial = "Initial feature";

const cases: { target: RebaseTarget; descendants: boolean; destination: string; insertBefore?: string; expected: Record<string, string>; moves: string[] }[] = [
  // Onto leaves the destination's children where they are.
  { target: "onto", descendants: false, destination: "B", expected: { X: "B", Y: initial, C: "B", D: "B" }, moves: [] },
  // After moves every child of the branch point onto the inserted change.
  { target: "after", descendants: false, destination: "B", expected: { X: "B", C: "X", D: "X", Y: initial }, moves: ["C", "D"] },
  // Before puts the change under the branch point, whose children stay on it.
  { target: "before", descendants: false, destination: "B", expected: { X: initial, B: "X", C: "B", D: "B", Y: initial }, moves: ["B", "C", "D"] },
  // Between moves only the second boundary; the branch point's other child stays.
  { target: "between", descendants: false, destination: "B", insertBefore: "C", expected: { X: "B", C: "X", D: "B", Y: initial }, moves: ["C"] },
  // With descendants, the destination's children land on the moved stack's head.
  { target: "after", descendants: true, destination: "B", expected: { X: "B", Y: "X", C: "Y", D: "Y" }, moves: ["C", "D"] },
  { target: "between", descendants: true, destination: "B", insertBefore: "D", expected: { X: "B", Y: "X", D: "Y", C: "B" }, moves: ["D"] },
];

for (const item of cases) {
  test(`rebase ${item.target}${item.descendants ? " with descendants" : ""} sets the parents jj gives a branched destination`, async () => {
    const t = await setup();
    try {
      const action: RebaseMutation = { kind: "rebase", revision: await t.revision("X"), destination: await t.revision(item.destination),
        descendants: item.descendants, target: item.target, ...(item.insertBefore ? { insertBefore: await t.revision(item.insertBefore) } : {}) };
      const before = await t.repo.operationId();
      const prepared = await t.repo.prepare(action);
      // Previewing runs the real command without touching the repository.
      expect(await t.repo.operationId()).toBe(before);
      expect(await t.parents()).toMatchObject({ X: initial, C: "B", D: "B" });
      if (item.target !== "onto") {
        const moved = prepared.summary.split("\n").filter(line => line.startsWith("↳ ")).map(line => line.split(" ").at(-1));
        expect(moved.sort()).toEqual(item.moves);
      }
      await t.repo.apply(prepared);
      expect(await t.parents()).toMatchObject(item.expected);
    } finally { await t.cleanup(); }
  });
}

test("each target builds jj's flags, between with both", () => {
  const revision = (commitId: string) => ({ commitId } as Revision);
  const action = (target: RebaseTarget): RebaseMutation => ({ kind: "rebase", revision: revision("x"), destination: revision("d"), insertBefore: revision("b"), descendants: false, target });
  expect(mutationArgs(action("onto"))).toEqual(["rebase", "--revisions", "x", "--onto", "d"]);
  expect(mutationArgs(action("before"))).toEqual(["rebase", "--revisions", "x", "--insert-before", "d"]);
  expect(mutationArgs(action("after"))).toEqual(["rebase", "--revisions", "x", "--insert-after", "d"]);
  expect(mutationArgs(action("between"))).toEqual(["rebase", "--revisions", "x", "--insert-after", "d", "--insert-before", "b"]);
  expect(mutationArgs({ ...action("onto"), target: undefined, descendants: true })).toEqual(["rebase", "--source", "x", "--onto", "d"]);
});

test("the review names the target and both boundaries of a between rebase", async () => {
  const t = await setup();
  try {
    const prepared = await t.repo.prepare({ kind: "rebase", revision: await t.revision("X"), destination: await t.revision("B"),
      insertBefore: await t.revision("C"), descendants: false, target: "between" });
    expect(prepared.summary).toContain("Target: between two revisions");
    expect(prepared.summary).toMatch(/After {2}\S+ \/ \S+ B\nBefore \S+ \/ \S+ C/);
    expect(prepared.summary).toContain("Scope: selected revision only");
  } finally { await t.cleanup(); }
});

test("a combination jj rejects shows jj's error and changes nothing", async () => {
  const t = await setup();
  try {
    const before = await t.repo.operationId();
    // Inserting after C but before its ancestor B would make a cycle.
    const action: RebaseMutation = { kind: "rebase", revision: await t.revision("X"), destination: await t.revision("C"),
      insertBefore: await t.revision("B"), descendants: false, target: "between" };
    await expect(t.repo.prepare(action)).rejects.toThrow(/cycle|loop/i);
    expect(await t.repo.operationId()).toBe(before);
    expect(await t.parents()).toMatchObject({ X: initial, B: initial, C: "B", D: "B" });
  } finally { await t.cleanup(); }
});

test("an insert previewed before another operation must be reviewed again", async () => {
  const t = await setup();
  try {
    const prepared = await t.repo.prepare({ kind: "rebase", revision: await t.revision("X"), destination: await t.revision("B"), descendants: false, target: "before" });
    await t.jj("describe", "-r", 'description(exact:"D\n")', "-m", "D elsewhere");
    await expect(t.repo.apply(prepared)).rejects.toThrow("Review the action again before applying.");
    expect(await t.parents()).toMatchObject({ X: initial, B: initial });
  } finally { await t.cleanup(); }
});
