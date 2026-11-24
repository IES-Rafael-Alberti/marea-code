import { browserRandomUUID } from "../../browser-random-uuid.js";
import { RunClosureError, type RunClosureFailure } from "./run-closure-client.boundary.js";

export type ClosurePhase = "idle" | "confirming" | "busy" | "failed";

/**
 * One confirmation at a time. Every opened confirmation owns one idempotency key, so a retry
 * after a failure repeats the same request instead of ending anything twice.
 */
export class ClosureFlow {
  public phase: ClosurePhase = "idle";
  /** Why the last attempt failed; read only while the phase is "failed". */
  public failure: RunClosureFailure = { kind: "invalid" };
  private key = "";
  private abort: AbortController | null = null;

  constructor(
    private readonly perform: (idempotencyKey: string, signal: AbortSignal) => Promise<void>,
    private readonly onClosed: () => void,
    private readonly changed: () => void,
  ) {}

  public open(): void {
    this.key = `close:${browserRandomUUID()}`;
    this.phase = "confirming";
    this.changed();
  }

  /** A request in flight cannot be withdrawn, only waited for. */
  public cancel(): void {
    if (this.phase === "busy") return;
    this.phase = "idle";
    this.changed();
  }

  public async confirm(): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    this.phase = "busy";
    this.changed();
    try {
      await this.perform(this.key, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.failure = error instanceof RunClosureError ? error.failure : { kind: "invalid" };
      this.phase = "failed";
      this.changed();
      return;
    }
    if (controller.signal.aborted) return;
    this.phase = "idle";
    this.changed();
    this.onClosed();
  }

  public dispose(): void {
    this.abort?.abort();
  }
}
