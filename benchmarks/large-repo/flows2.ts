// @ts-nocheck
// Large-diff and rebase-preview flows. Usage:
//   flows2.ts diff <repo> <label> <small-commit> <big-commit>
//   flows2.ts rebase <repo> <source-commit> <destination-commit> <label>
import { Session, W, buckets, helperUsage, hwm, save, threadCpu } from "./lib";
const [mode, name, a, b, c] = process.argv.slice(2) as string[];
const repo = `${W}/repos/${name}`;
async function filtered(revset: string) {
  const s = new Session(repo);
  const t0 = Date.now();
  await s.start();
  if (!await s.waitScreen(x => /Ready/.test(x), 120_000)) throw new Error("not ready");
  await s.settle(t0, { min: 2 });
  s.key("L"); await Bun.sleep(150); s.key("C-a"); s.key("C-k"); s.key(revset, true); await Bun.sleep(100);
  const t = Date.now(); s.key("Enter");
  await s.settle(t, { min: 2, timeout: 180_000 });
  return s;
}
async function act(s: Session, go: () => void, o: { min?: number; timeout?: number } = {}) {
  const c0 = threadCpu(s.pid), t0 = Date.now();
  go();
  const d = await s.settle(t0, { min: o.min ?? 0, timeout: o.timeout ?? 240_000 });
  s.read();
  const preview = s.events.filter(e => e.k === "previewContent" && e.t >= t0 && e.chars > 300).at(-1);
  return { ...buckets(s, t0, d.done, c0, threadCpu(s.pid)), hwm: hwm(s.pid), ...helperUsage(s.pid), timedOut: d.timedOut, chars: preview?.chars, blocks: preview?.blocks, screen: s.screen().split("\n").filter(l => /error|Error|failed|long|exceeded|preview/.test(l)).slice(0, 3).join(" | ").slice(0, 240) };
}
const show = (flow: string, r: any) => console.log(`${name} ${flow} wall=${Math.round(r.wall)} jj=${Math.round(r.jjUnion)}(${r.jjCount}p) ts=${Math.round(r.tsMs)} render=${Math.round(r.renderMs)} workers=${Math.round(r.workerCpu)} previewSet=${Math.round(r.previewMs)} stall=${Math.round(r.maxStall)} chars=${r.chars} blocks=${r.blocks} rss=${Math.round(r.hwm)}${r.timedOut ? " TIMEOUT" : ""} ${r.screen ?? ""}`);
if (mode === "diff") {
  const [label, small, big] = [a!, b!, c!];
  const s = await filtered(`${small} | ${big}`);
  const reps = Number(process.env.REPEAT ?? 5);
  for (let i = 0; i <= reps; i++) {
    const r = await act(s, () => s.key("j"), { min: 1 });
    if (i) { save("flows.jsonl", { repo: name, flow: `diff:${label}`, i, ...r }); show(`diff:${label}#${i}`, r); }
    if (r.wall > 45_000 && i >= 2) break;
    if (i === reps) {
      for (let p = 0; p < 3; p++) {
        const page = await act(s, () => s.key("PageDown"));
        save("flows.jsonl", { repo: name, flow: `diff-page:${label}`, i: p, ...page }); show(`page#${p}`, page);
      }
    }
    const away = await act(s, () => s.key("k"));
    if (i) { save("flows.jsonl", { repo: name, flow: `diff-away:${label}`, i, ...away }); show(`away#${i}`, away); }
    await act(s, () => s.key("C-r"), { min: 3 });   // clears the diff cache so the next open is a real one
  }
  await s.stop();
} else {
  const [source, destination, label] = [a!, b!, c!];
  for (const scope of ["only", "descendants"]) {
    const s = await filtered(`${source} | ${destination}`);
    const start = await act(s, () => s.key("r"), { min: 1 });
    save("flows.jsonl", { repo: name, flow: `rebase-start:${label}`, i: 0, ...start }); show("rebase-start", start);
    if (scope === "descendants") { s.key("Tab"); await Bun.sleep(100); }
    s.key("j"); await Bun.sleep(300);
    const reps = Number(process.env.REPEAT ?? 5);
    for (let i = 0; i <= reps; i++) {
      const r = await act(s, () => s.key("Enter"), { min: 5 });
      if (i) { save("flows.jsonl", { repo: name, flow: `rebase-${scope}:${label}`, i, ...r }); show(`rebase-${scope}#${i}`, r); }
      if (i === reps) console.log(JSON.stringify(r.procs));
      if (r.wall > 45_000 && i >= 2) break;
      await act(s, () => s.key("Escape"));
      await Bun.sleep(200);
    }
    await s.stop();
  }
}
