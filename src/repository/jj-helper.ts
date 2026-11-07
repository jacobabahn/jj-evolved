import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CancelledError, jjEnv, run, timeoutMessage, type RunOptions } from "./jj-process";

/** The reads the helper can answer; see native/PROTOCOL.md. Revsets, templates and paths are the CLI's text, unchanged. */
export type HelperRequest =
  | { kind: "opId" }
  | { kind: "log"; revset: string; template: string; limit?: number; graph: boolean; op?: string }
  | { kind: "diff"; commitId: string; paths: string[] }
  | { kind: "files"; commitId: string; template: string }
  | { kind: "bookmarks"; template: string }
  | { kind: "tags"; template: string }
  | { kind: "remotes" };

const PROTOCOL = 1;
/** The helper exits with this when config it read has changed, so the next process picks up the new config. */
const CONFIG_CHANGED = 75;
const CRASH_LIMIT = 3;
const MAX_HEADER_BYTES = 1 << 20;
/** How long a helper that closed stdout gets to exit, so its status can be read, before it counts as a crash. */
const EXIT_GRACE_MS = 1_000;

/** Mutable so tests need not wait a minute. */
export const helperSettings = { idleMs: 60_000 };

const defaultBinary = resolve(import.meta.dir, "../../native/target/release/jj-evolved-helper");

/** The helper to run, or undefined for CLI only. A missing binary is the normal case, not an error. */
function helperBinary(): string | undefined {
  const configured = process.env.JJ_EVOLVED_HELPER;
  if (configured === "off") return undefined;
  const path = configured ? resolve(configured) : defaultBinary;
  return existsSync(path) ? path : undefined;
}

type Header = { len: number; ready?: unknown; jjVersion?: unknown; protocol?: unknown; id?: unknown; ok?: unknown };
export type Frame = { header: Header; payload: Uint8Array };

/** Splits helper stdout into frames, whatever the chunk boundaries. Throws on anything that is not a frame. */
export class FrameParser {
  private headerChunks: Uint8Array[] = [];
  private headerBytes = 0;
  private header: Header | null = null;
  private payload = new Uint8Array();
  private filled = 0;

  *push(chunk: Uint8Array): Generator<Frame> {
    let offset = 0;
    for (;;) {
      if (!this.header) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        this.headerChunks.push(chunk.subarray(offset, end));
        this.headerBytes += end - offset;
        if (this.headerBytes > MAX_HEADER_BYTES) throw new Error("Oversized helper header.");
        if (newline < 0) return;
        offset = newline + 1;
        this.header = parseHeader(Buffer.concat(this.headerChunks));
        this.headerChunks = [];
        this.headerBytes = 0;
        this.payload = new Uint8Array(this.header.len);
        this.filled = 0;
      }
      const take = Math.min(this.payload.length - this.filled, chunk.length - offset);
      this.payload.set(chunk.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled < this.payload.length) return;
      const frame = { header: this.header, payload: this.payload };
      this.header = null;
      yield frame;
      if (offset === chunk.length) return;
    }
  }
}

function parseHeader(bytes: Uint8Array): Header {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== "object" || value === null || !("len" in value) || !Number.isSafeInteger(value.len) || (value.len as number) < 0) {
    throw new Error("Malformed helper header.");
  }
  return value as Header;
}

/** The release from `jj 0.45.1-<commit>`, or a bare `0.45.1`; the commit is not part of what the gate compares. */
function release(version: string): string | undefined {
  return /^(?:jj\s+)?(\d+\.\d+\.\d+)/.exec(version.trim())?.[1];
}

let installedVersion: Promise<string | undefined> | undefined;
/** One spawn per process. It runs outside any repository, since it may outlive the root that first asked. */
function jjVersion(): Promise<string | undefined> {
  installedVersion ??= run("/", ["--version"]).then(release, () => undefined);
  return installedVersion;
}

/** What became of a read: the payload, or undefined when the CLI must run it. Timeouts and cancellation reject. */
type Pending = {
  request: HelperRequest;
  timeoutMs: number;
  settle: (payload: string | undefined) => void;
  fail: (error: Error) => void;
  id: number;
  sent: boolean;
  retried: boolean;
  timer?: Timer;
};

type Connection = { proc: Bun.Subprocess<"pipe", "pipe", "ignore">; ready: boolean };

/** One process and its FIFO: one request in flight, the rest queued. Queued requests outlive the process. */
class Lane {
  private readonly queue: Pending[] = [];
  private current: Pending | null = null;
  private connection: Connection | null = null;
  private idleTimer: Timer | undefined;
  private nextId = 0;

  constructor(private readonly helpers: RootHelpers) {}

  enqueue(pending: Pending) {
    this.queue.push(pending);
    this.pump();
  }

  /** Withdraws a request. A killed helper is how a request in flight stops; one still queued, or waiting for `ready`, costs nothing. */
  cancel(pending: Pending) {
    const queued = this.queue.indexOf(pending);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      pending.fail(new CancelledError(false));
    } else if (this.current === pending) {
      if (pending.sent) this.stop();
      this.release(pending);
      pending.fail(new CancelledError(pending.sent));
      this.pump();
    }
  }

  stop() {
    const connection = this.connection;
    this.connection = null;
    clearTimeout(this.idleTimer);
    connection?.proc.kill("SIGKILL");
  }

  /** Gives up on the helper: everything waiting here goes to the CLI. */
  drain() {
    this.stop();
    const waiting = [...(this.current ? [this.current] : []), ...this.queue.splice(0)];
    if (this.current) this.release(this.current);
    for (const pending of waiting) pending.settle(undefined);
  }

  private release(pending: Pending) {
    clearTimeout(pending.timer);
    this.current = null;
  }

  private pump() {
    clearTimeout(this.idleTimer);
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) {
      if (this.connection) {
        this.idleTimer = setTimeout(() => this.stop(), helperSettings.idleMs);
        this.idleTimer.unref();
      }
      return;
    }
    this.current = next;
    next.sent = false;
    // The clock starts here, not on enqueue, so waiting behind a slow read neither counts against this one nor kills that
    // one. Unlike the process, the timer stays referenced: it keeps the event loop alive while a read is outstanding.
    next.timer = setTimeout(() => this.timedOut(next), next.timeoutMs);
    if (!this.connection) this.spawn();
    else if (this.connection.ready) this.send(this.connection, next);
  }

  private timedOut(pending: Pending) {
    // A helper that never became ready is broken, not slow, and the CLI may well answer.
    if (!this.connection?.ready) { this.stop(); this.crashed(); return; }
    this.stop();
    this.release(pending);
    pending.fail(new Error(timeoutMessage(pending.timeoutMs)));
    this.pump();
  }

  private spawn() {
    let proc: Connection["proc"];
    try {
      proc = Bun.spawn([helperBinary() ?? "", "--repository", this.helpers.root, "--ignore-working-copy", "--at-op=@", "--no-pager", "--color=never",
        "--config", "ui.log-word-wrap=false", "serve"], {
        // Not detached, unlike run(): it reads nothing from the terminal and should die with the app's process group.
        // Stderr is not part of the protocol, and an unread pipe could eventually block the helper.
        cwd: this.helpers.root, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: false, env: jjEnv(),
      });
    } catch { this.crashed(); return; }
    proc.unref();
    proc.stdin.unref();
    const connection: Connection = { proc, ready: false };
    this.connection = connection;
    void jjVersion();
    void this.follow(connection);
  }

  /** Owns a process from start to exit. Once `stop` has detached it, whatever it still does is ignored. */
  private async follow(connection: Connection) {
    const { proc } = connection;
    const frames = new FrameParser();
    const reader = proc.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of frames.push(value)) {
          if (connection !== this.connection) return;
          await this.receive(connection, frame);
        }
      }
    } catch {
      // Malformed output means nothing further from this process can be trusted.
      if (connection === this.connection) { this.stop(); this.crashed(); }
      return;
    }
    if (connection !== this.connection) return;
    const graceful = await Promise.race([proc.exited, new Promise<undefined>(done => { setTimeout(done, EXIT_GRACE_MS).unref(); })]);
    if (connection !== this.connection) return;
    this.stop();
    if (graceful === CONFIG_CHANGED) this.configChanged();
    else this.crashed();
  }

  private async receive(connection: Connection, { header, payload }: Frame) {
    if (!connection.ready) {
      if (header.ready !== true) {
        if (header.ready !== false) throw new Error("Helper spoke before it was ready.");
        this.stop();
        this.crashed();
        return;
      }
      const version = await jjVersion();
      if (connection !== this.connection) return;
      if (header.protocol !== PROTOCOL || typeof header.jjVersion !== "string" || !version || release(header.jjVersion) !== version) {
        disableHelpers();
        return;
      }
      connection.ready = true;
      if (this.current) this.send(connection, this.current);
      return;
    }
    const pending = this.current;
    if (!pending?.sent || header.id !== pending.id || typeof header.ok !== "boolean") throw new Error("Unexpected helper response.");
    // Decoded once here, so a character split across chunks survives. Same replacement of invalid UTF-8 as `Response.text()`.
    const text = header.ok ? new TextDecoder().decode(payload) : undefined;
    this.release(pending);
    pending.settle(text);
    this.pump();
  }

  private send(connection: Connection, pending: Pending) {
    pending.sent = true;
    pending.id = ++this.nextId;
    try {
      const { stdin } = connection.proc;
      stdin.write(`${JSON.stringify({ id: pending.id, ...pending.request })}\n`);
      void Promise.resolve(stdin.flush()).catch(() => {});
    } catch { /* The process is gone, and its end of stdout is what reports that. */ }
  }

  /** The read in flight goes back to the front, once: the next process has the new config. */
  private configChanged() {
    const pending = this.current;
    if (pending) {
      this.release(pending);
      if (pending.retried) pending.settle(undefined);
      else { pending.retried = true; this.queue.unshift(pending); }
    }
    this.pump();
  }

  private crashed() {
    const pending = this.current;
    if (pending) { this.release(pending); pending.settle(undefined); }
    if (++this.helpers.crashes >= CRASH_LIMIT) this.helpers.disable();
    this.pump();
  }
}

class RootHelpers {
  crashes = 0;
  disabled = false;
  private readonly lanes = { fast: new Lane(this), bulk: new Lane(this) };

  constructor(readonly root: string) {}

  /** Scans of whole histories get their own process, so a slow search cannot hold up selection reads. */
  lane(bulk: boolean): Lane {
    return bulk ? this.lanes.bulk : this.lanes.fast;
  }

  disable() {
    this.disabled = true;
    this.lanes.fast.drain();
    this.lanes.bulk.drain();
  }
}

const registry = new Map<string, RootHelpers>();
let sessionDisabled = false;

/** A helper built against another jj must not read this repository: the app follows whatever jj the user has. */
function disableHelpers() {
  sessionDisabled = true;
  for (const helpers of registry.values()) helpers.disable();
}

function laneFor(root: string, bulk: boolean): Lane | undefined {
  if (sessionDisabled || !helperBinary()) return undefined;
  let helpers = registry.get(root);
  if (!helpers) registry.set(root, helpers = new RootHelpers(root));
  return helpers.disabled ? undefined : helpers.lane(bulk);
}

/**
 * Reads through the helper when there is one, and otherwise through `fallback`, the CLI command the request mirrors. The
 * CLI also takes over from any helper failure, so it stays the only source of errors the user sees; only a timeout or a
 * cancellation rejects from here, as a CLI run would.
 */
export async function read(root: string, request: HelperRequest, fallback: () => Promise<string>, options: RunOptions & { bulk?: boolean } = {}): Promise<string> {
  const { timeoutMs = 30_000, signal, bulk = false } = options;
  if (signal?.aborted) throw new CancelledError(false);
  const lane = laneFor(root, bulk);
  if (!lane) return fallback();
  let abort = () => {};
  const payload = await new Promise<string | undefined>((settle, fail) => {
    const pending: Pending = { request, timeoutMs, settle, fail, id: 0, sent: false, retried: false };
    abort = () => lane.cancel(pending);
    signal?.addEventListener("abort", abort, { once: true });
    lane.enqueue(pending);
  }).finally(() => signal?.removeEventListener("abort", abort));
  return payload ?? fallback();
}

/** Stops every helper and forgets all session state. For tests. */
export function resetHelpers() {
  for (const helpers of registry.values()) helpers.disable();
  registry.clear();
  sessionDisabled = false;
  installedVersion = undefined;
}
