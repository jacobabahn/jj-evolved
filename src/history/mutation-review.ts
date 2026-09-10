import type { Mutation, PreparedMutation } from "../repository/model";
import type { Repository } from "../repository/repository";
import { terminalText } from "../terminal-text";

type ReviewState =
  | { kind: "idle" | "preparing" | "applying" | "applied" | "disposed" }
  | { kind: "ready"; prepared: PreparedMutation };

type ApplyResult =
  | { kind: "not-ready" | "disposed" }
  | { kind: "applied"; action: Mutation; refreshError: string | null };

export class MutationReview {
  private state: ReviewState = { kind: "idle" };

  constructor(
    private readonly repository: Pick<Repository, "prepare" | "apply">,
    private readonly refresh: (action: Mutation) => Promise<void>,
  ) {}

  get ready() { return this.state.kind === "ready"; }
  get applying() { return this.state.kind === "applying"; }

  async prepare(action: Mutation): Promise<PreparedMutation | null> {
    if (this.applying || this.state.kind === "disposed") return null;
    const pending: ReviewState = { kind: "preparing" };
    this.state = pending;
    try {
      const prepared = await this.repository.prepare(action);
      if (this.state !== pending) return null;
      this.state = { kind: "ready", prepared };
      return prepared;
    } catch (error) {
      if (this.state !== pending) return null;
      this.state = { kind: "idle" };
      throw error;
    }
  }

  async apply(): Promise<ApplyResult> {
    if (this.state.kind !== "ready") return { kind: "not-ready" };
    const { prepared } = this.state;
    const applying: ReviewState = { kind: "applying" };
    this.state = applying;
    try {
      await this.repository.apply(prepared);
    } catch (error) {
      if (this.state !== applying) return { kind: "disposed" };
      this.state = { kind: "idle" };
      throw error;
    }
    if (this.state !== applying) return { kind: "disposed" };
    let refreshError: string | null = null;
    try {
      await this.refresh(prepared.action);
    } catch (error) {
      const message = terminalText(error instanceof Error ? error.message : String(error));
      refreshError = `Operation succeeded, but refresh failed. Press r; do not repeat the action. ${message}`;
    }
    if (this.state !== applying) return { kind: "disposed" };
    this.state = { kind: "applied" };
    return { kind: "applied", action: prepared.action, refreshError };
  }

  cancel() {
    if (!this.applying && this.state.kind !== "disposed") this.state = { kind: "idle" };
  }

  dispose() { this.state = { kind: "disposed" }; }
}
