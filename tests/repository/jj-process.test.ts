import { expect, test } from "bun:test";
import { CancelledError, run } from "../../src/repository/jj-process";
import { fixture } from "../fixture";

test("an aborted command stops with CancelledError, and a timeout names its limit", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(run(f.path, ["log", "-r", "all()"], false, {}, { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    await expect(run(f.path, ["log", "-r", "all()"], false, {}, { timeoutMs: 1 })).rejects.toThrow("exceeded 0.001 seconds");
    expect(await run(f.path, ["log", "-r", "@", "--no-graph", "-T", "description"], false, {}, { timeoutMs: null })).toBe("Next change\n");
  } finally { await f.cleanup(); }
});
