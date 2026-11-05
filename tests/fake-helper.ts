// Speaks native/PROTOCOL.md and misbehaves on request, so the client can be tested without native/ being built.
// FAKE_HELPER_START picks how it starts. A `log` request's revset picks how it answers: see `answer`, and so does a
// `diff` request's commit ID when it holds a colon or is `hang`. Any other request answers with its own kind, and
// FAKE_HELPER_REFUSE turns every request down. Everything it does is appended to FAKE_HELPER_LOG as JSON lines.
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";

const logPath = process.env.FAKE_HELPER_LOG!;
const version = process.env.FAKE_HELPER_VERSION!;
const start = process.env.FAKE_HELPER_START ?? "ready";
const encoder = new TextEncoder();

// A helper the client failed to kill must not outlive the test run.
setTimeout(() => process.exit(99), 30_000);

appendFileSync(logPath, `${JSON.stringify({ started: process.pid, args: process.argv.slice(2), interactive: process.env.JJ_INTERACTIVE })}\n`);

/** True the first time this text is seen across all of a test's helpers. */
function firstTime(text: string) {
  const marker = `${logPath}.${text}`;
  if (existsSync(marker)) return false;
  writeFileSync(marker, "");
  return true;
}

function write(data: string | Uint8Array) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  for (let offset = 0; offset < bytes.length;) {
    try { offset += writeSync(1, bytes, offset); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; Bun.sleepSync(1); }
  }
}
function reply(id: number, payload: string | Uint8Array) {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  write(`${JSON.stringify({ id, ok: true, len: bytes.length })}\n`);
  write(bytes);
}

async function answer(id: number, kind: string, script: string | undefined) {
  if (process.env.FAKE_HELPER_REFUSE) { write(`${JSON.stringify({ id, ok: false, error: "refused", len: 0 })}\n`); return; }
  const [command = "", ...rest] = (script ?? "").split(":");
  const text = rest.join(":");
  switch (script === undefined ? "other" : command) {
    case "other": reply(id, kind); return;
    case "echo": reply(id, text); return;
    case "slow": await Bun.sleep(Number(rest[0])); reply(id, rest.slice(1).join(":")); return;
    case "big": reply(id, new Uint8Array(Number(text)).fill(120)); return;
    case "reject": write(`${JSON.stringify({ id, ok: false, error: "no", len: 0 })}\n`); return;
    case "crash": process.exit(1);
    case "exit-zero": process.exit(0);
    case "crash-mid": write(`${JSON.stringify({ id, ok: true, len: 100 })}\npartial`); process.exit(1);
    case "exit75": process.exit(75);
    case "exit75-once": if (firstTime(text)) process.exit(75); reply(id, text); return;
    case "exit75-mid": if (firstTime(text)) { write(`${JSON.stringify({ id, ok: true, len: 100 })}\npartial`); process.exit(75); } reply(id, text); return;
    case "hang": await Bun.sleep(60_000); return;
    case "garbage": write("this is not json\n"); return;
    case "no-newline": write(new Uint8Array(1 << 21).fill(120)); return;
    case "negative": write(`${JSON.stringify({ id, ok: true, len: -1 })}\n`); return;
    case "wrong-id": write(`${JSON.stringify({ id: id + 1000, ok: true, len: 0 })}\n`); return;
    case "after-reply": reply(id, text); await Bun.sleep(20); process.exit(1);
    case "split": {
      // Every byte of the header arrives alone, and the payload breaks inside a multi-byte character.
      const bytes = encoder.encode(text);
      for (const byte of encoder.encode(`${JSON.stringify({ id, ok: true, len: bytes.length })}\n`)) { write(new Uint8Array([byte])); await Bun.sleep(1); }
      for (const byte of bytes) { write(new Uint8Array([byte])); await Bun.sleep(1); }
      return;
    }
    default: throw new Error(`Unknown fake request ${script}`);
  }
}

const ready = { ready: true, jjVersion: version, protocol: 1, len: 0 };
switch (start) {
  case "ready": write(`${JSON.stringify(ready)}\n`); break;
  case "split": { const line = `${JSON.stringify(ready)}\n`; write(line.slice(0, 5)); await Bun.sleep(20); write(line.slice(5)); break; }
  case "wrong-version": write(`${JSON.stringify({ ...ready, jjVersion: "0.0.1" })}\n`); break;
  case "wrong-protocol": write(`${JSON.stringify({ ...ready, protocol: 2 })}\n`); break;
  case "not-ready": write(`${JSON.stringify({ ready: false, error: "no repository", len: 0 })}\n`); process.exit(1); break;
  case "crash": process.exit(1); break;
  case "garbage": write("{\n"); break;
  case "hang": break;
  default: throw new Error(`Unknown fake start ${start}`);
}

let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk);
  for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const request = JSON.parse(line);
    appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, request })}\n`);
    const scripted = request.kind === "log" ? request.revset
      : request.kind === "diff" && (request.commitId.includes(":") || request.commitId === "hang") ? request.commitId : undefined;
    await answer(request.id, request.kind, scripted);
    appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, done: request.id })}\n`);
  }
}
appendFileSync(logPath, `${JSON.stringify({ eof: process.pid })}\n`);
process.exit(0);
