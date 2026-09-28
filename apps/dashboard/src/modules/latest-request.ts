import { UsageHealthRequestError } from "./usage-health-client.boundary.js";

export type RequestOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly status: "denied" | "error" };

/** One request at a time: replaced or cancelled requests never settle, even if the port ignores abort. */
export class LatestRequest {
  private pending: AbortController | undefined;

  async run<Value>(
    request: (signal: AbortSignal) => Promise<Value>,
    settle: (outcome: RequestOutcome<Value>) => void,
  ): Promise<void> {
    this.cancel();
    const pending = new AbortController();
    this.pending = pending;
    let outcome: RequestOutcome<Value>;
    try {
      outcome = { ok: true, value: await request(pending.signal) };
    } catch (error) {
      // Authentication and authorization refusals get their own safe state; nothing else is exposed.
      const denied =
        error instanceof UsageHealthRequestError && (error.status === 401 || error.status === 403);
      outcome = { ok: false, status: denied ? "denied" : "error" };
    }
    if (!pending.signal.aborted) settle(outcome);
  }

  cancel(): void {
    this.pending?.abort();
  }
}
