import { expect, test } from "bun:test";
import { CancelledError, NETWORK_TIMEOUT_MS, run } from "../../src/repository/jj-process";
import { fixture } from "../fixture";

test("an aborted command stops with CancelledError, and a timeout names its limit", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(run(f.path, ["log", "-r", "all()"], false, {}, { signal: controller.signal })).rejects.toEqual(new CancelledError(false));
    const running = new AbortController();
    const stopped = run(f.path, ["util", "exec", "--", "sleep", "30"], false, {}, { signal: running.signal });
    await Bun.sleep(100);
    running.abort();
    await expect(stopped).rejects.toMatchObject({ name: "CancelledError", started: true });
    await expect(run(f.path, ["log", "-r", "all()"], false, {}, { timeoutMs: 1 })).rejects.toThrow("exceeded 0.001 seconds");
    expect(await run(f.path, ["log", "-r", "@", "--no-graph", "-T", "description"], false, {}, { timeoutMs: NETWORK_TIMEOUT_MS })).toBe("Next change\n");
  } finally { await f.cleanup(); }
});
