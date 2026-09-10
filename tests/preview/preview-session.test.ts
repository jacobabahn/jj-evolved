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
