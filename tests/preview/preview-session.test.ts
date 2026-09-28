import { expect, test } from "bun:test";
import { PreviewSession, type PreviewContent } from "../../src/preview/preview-session";

function fixture() {
  const frames: PreviewContent[] = [];
  const session = new PreviewSession(frame => { frames.push(frame); });
  return { session, frames };
}

for (const settle of ["resolve", "reject"] as const) {
  test(`a late ${settle} cannot replace a newer selection across panes`, async () => {
    const { session, frames } = fixture();
    const old = Promise.withResolvers<string>();
    const pending = session.load({ target: "main", title: "Old diff", loading: "Loading old…", read: () => old.promise });
    await session.load({ target: "overlay", title: "New file", loading: "Loading new…", read: async () => "New file diff" });
    const count = frames.length;
    if (settle === "resolve") old.resolve("Old diff"); else old.reject(new Error("Old failure"));
    await pending;
    expect(frames).toHaveLength(count);
    expect(frames.at(-1)).toEqual({ target: "overlay", title: "New file", text: "New file diff" });
  });
}

test("showing help replaces an in-flight diff", async () => {
  const { session, frames } = fixture();
  const gate = Promise.withResolvers<string>();
  const pending = session.load({ target: "main", title: "Diff", loading: "Loading…", read: () => gate.promise });
  session.show({ target: "main", title: "Help", text: "Keyboard reference" });
  gate.resolve("Obsolete diff");
  await pending;
  expect(frames.at(-1)?.text).toBe("Keyboard reference");
});

for (const end of ["cancel", "dispose"] as const) {
  test(`${end} suppresses a pending error`, async () => {
    const { session, frames } = fixture();
    const gate = Promise.withResolvers<string>();
    const pending = session.load({ target: "overlay", title: "File", loading: "Loading…", read: () => gate.promise });
    session[end]();
    gate.reject(new Error("Failed after close"));
    await pending;
    expect(frames).toHaveLength(1);
    if (end === "dispose") {
      session.show({ target: "main", title: "Help", text: "Help" });
      await session.load({ target: "main", title: "Diff", loading: "Loading…", read: async () => { throw new Error("Should not read"); } });
      expect(frames).toHaveLength(1);
    }
  });
}

test("current results retain metadata, empty text, and readable error details", async () => {
  const { session, frames } = fixture();
  await session.load({ target: "main", title: "Diff", loading: "Loading…", prefix: "Selected change\n", empty: "Empty change", read: async () => "\n" });
  expect(frames.at(-1)?.text).toBe("Selected change\nEmpty change");
  await session.load({ target: "main", title: "Status", loading: "Loading…", errorTitle: "Status error", read: async () => { throw new Error("Failed\u0007"); } });
  expect(frames.at(-1)).toEqual({ target: "main", title: "Status error", text: "Failed" });
});

test("cached text renders at once without reading or a loading frame", async () => {
  const { session, frames } = fixture();
  await session.load({ target: "main", title: "Diff", loading: "Loading…", prefix: "Change\n", cached: "Cached diff", delay: 50, read: async () => { throw new Error("Should not read"); } });
  expect(frames).toEqual([{ target: "main", title: "Diff", text: "Change\nCached diff" }]);
});

test("debounced loads coalesce rapid selections into one read of the latest", async () => {
  const { session, frames } = fixture();
  const reads: string[] = [];
  const load = (name: string) => session.load({ target: "main", title: name, loading: `Loading ${name}…`, delay: 20, read: async () => { reads.push(name); return `${name} diff`; } });
  await Promise.all([load("first"), load("second"), load("third")]);
  expect(reads).toEqual(["third"]);
  expect(frames.map(frame => frame.text)).toEqual(["Loading first…", "Loading second…", "Loading third…", "third diff"]);
});

test("a cached selection supersedes an in-flight debounced read", async () => {
  const { session, frames } = fixture();
  const gate = Promise.withResolvers<string>();
  let reads = 0;
  const pending = session.load({ target: "main", title: "Old", loading: "Loading…", delay: 5, read: () => { reads++; return gate.promise; } });
  await Bun.sleep(20);
  await session.load({ target: "main", title: "New", loading: "Loading…", cached: "New diff", read: async () => "unused" });
  gate.resolve("Old diff");
  await pending;
  expect(reads).toBe(1);
  expect(frames.at(-1)).toEqual({ target: "main", title: "New", text: "New diff" });
});

for (const end of ["cancel", "dispose"] as const) {
  test(`${end} ends a pending debounce without reading`, async () => {
    const { session, frames } = fixture();
    let reads = 0;
    const pending = session.load({ target: "main", title: "Diff", loading: "Loading…", delay: 10_000, read: async () => { reads++; return "diff"; } });
    session[end]();
    await pending;
    expect(reads).toBe(0);
    expect(frames).toHaveLength(1);
  });
}
