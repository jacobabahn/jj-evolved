import { expect, test } from "bun:test";
import { fixture } from "./fixture";
import { Repository } from "../src/repository";

const template = 'change_id.short(8) ++ " " ++ local_bookmarks.map(|b| b.name()).join(" ") ++ " " ++ description.first_line() ++ if(conflict, " [conflict]") ++ "\\n\\n"';


for (const descendants of [false, true]) {
  test(`projected rebase tree matches jj after applying, descendants=${descendants}`, async () => {
    const f = await fixture();
    try {
      const repo = await Repository.open(f.path);
      const source = (await repo.snapshot("@")).revisions[0];
      await f.jj("new", "-m", "Child left behind or moved");
      await f.jj("new", "root()", "-m", "Destination");
      const destination = (await repo.snapshot("@")).revisions[0];
      if (!source || !destination) throw new Error("Missing revisions");
      const before = await repo.operationId();
      const snapshot = await repo.snapshot("all()");
      const beforeTree = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      const prepared = await repo.prepare({ kind: "rebase", revision: source, destination, descendants });
      expect(prepared.trees?.before).toBe(beforeTree);
      expect(await repo.operationId()).toBe(before);
      expect((await repo.snapshot("all()")).revisions).toEqual(snapshot.revisions);
      expect(prepared.trees?.after).toContain("Child left behind or moved");
      await repo.apply(prepared);
      const actual = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      expect(prepared.trees?.after).toBe(actual);
    } finally { await f.cleanup(); }
  });
}

for (const partial of [false, true]) {
  test(`projected squash tree matches jj and preview preserves files, partial=${partial}`, async () => {
    const f = await fixture();
    try {
      const repo = await Repository.open(f.path);
      await Bun.write(`${f.path}/one.txt`, "one\n");
      await Bun.write(`${f.path}/two.txt`, "two\n");
      const source = (await repo.snapshot("@")).revisions[0];
      const destination = (await repo.snapshot("feature")).revisions[0];
      await f.jj("new", "-m", "Child of squashed change");
      if (!source || !destination) throw new Error("Missing revisions");
      const before = await repo.operationId();
      const snapshot = await repo.snapshot("all()");
      const beforeTree = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      const prepared = await repo.prepare({ kind: "squash", revision: source, destination, files: partial ? ["one.txt"] : [], description: "Combined" });
      expect(prepared.trees?.before).toBe(beforeTree);
      expect(await repo.operationId()).toBe(before);
      expect((await repo.snapshot("all()")).revisions).toEqual(snapshot.revisions);
      expect(await Bun.file(`${f.path}/one.txt`).text()).toBe("one\n");
      expect(await Bun.file(`${f.path}/two.txt`).text()).toBe("two\n");
      expect(prepared.trees?.after?.includes(source.changeId.slice(0, 8))).toBe(partial);
      expect(prepared.trees?.after).toMatch(/^│\s*$/m);
      await repo.apply(prepared);
      const actual = await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template);
      expect(prepared.trees?.after).toBe(actual);
    } finally { await f.cleanup(); }
  });
}

test("an unchanged rebase still renders a tree without creating a live operation", async () => {
  const f = await fixture();
  try {
    const repo = await Repository.open(f.path);
    const source = (await repo.snapshot("@")).revisions[0];
    const destination = (await repo.snapshot("@-")).revisions[0];
    if (!source || !destination) throw new Error("Missing revisions");
    const before = await repo.operationId();
    const prepared = await repo.prepare({ kind: "rebase", revision: source, destination, descendants: false });
    expect(prepared.trees?.after).toBe(await f.jj("log", "--config", "ui.log-word-wrap=false", "-r", "all()", "-T", template));
    expect(await repo.operationId()).toBe(before);
  } finally { await f.cleanup(); }
});
