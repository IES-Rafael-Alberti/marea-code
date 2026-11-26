import { MessageIdSchema, type RunToken } from "@marea/protocol";

import type { Clock, IdSource } from "./contracts.js";
import { StudentHttpError } from "./http-error.js";
import type { LocalSession } from "./local-session.js";
import type { TurnDiagnosticsOptions } from "./turn-diagnostic-report.js";
import { failureDiagnostic, failureOrigin } from "./turn-diagnostics.boundary.js";

/** The background connection checks a student session runs while the student works. */
export type ConnectionCheck = "presence" | "lease-renewal";

export interface ConnectionDiagnosticsOptions {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly localSession: LocalSession;
  readonly diagnostics: Omit<TurnDiagnosticsOptions, "reportToServer"> | undefined;
  /** True once the teacher server announced `marea.runs.turn-diagnostics`. */
  readonly reportToServer: () => boolean;
}

/**
 * Records failed background connection checks instead of hiding them: in the private local log
 * and, on servers that store them, as a `turn-diagnostic` the teacher sees with the session.
 * The same failure is recorded at most once every ten minutes, so a long outage stays a few
 * lines; a successful check starts a fresh report for the next failure.
 */
export class ConnectionDiagnostics {
  readonly #reported = new Map<string, number>();

  public constructor(private readonly options: ConnectionDiagnosticsOptions) {}

  /** One background heartbeat: the lease check, then presence; a failure is recorded. */
  public async heartbeat(
    token: () => Promise<RunToken>,
    send: (token: RunToken) => Promise<void>,
  ): Promise<void> {
    let check: ConnectionCheck = "lease-renewal";
    try {
      const value = await token();
      this.succeeded(check);
      check = "presence";
      await send(value);
      this.succeeded(check);
    } catch (error) {
      await this.failed(check, error);
    }
  }

  public succeeded(check: ConnectionCheck): void {
    for (const key of this.#reported.keys())
      if (key.startsWith(`${check}/`)) this.#reported.delete(key);
  }

  public async failed(check: ConnectionCheck, error: unknown): Promise<void> {
    const diagnostics = this.options.diagnostics;
    if (diagnostics === undefined) return;
    const category = `${check}/${failureOrigin(error)}`;
    const occurredAt = this.options.clock.now();
    const at = Date.parse(occurredAt);
    if (at - (this.#reported.get(category) ?? -Infinity) < 10 * 60 * 1_000) return;
    this.#reported.set(category, at);
    const status = error instanceof StudentHttpError ? { status: error.status } : {};
    try {
      await diagnostics.log.append({ occurredAt, kind: "connection-failed", category, ...status });
    } catch {
      // The local copy is best effort; a failed check never interrupts the student.
    }
    if (!this.options.reportToServer()) return;
    const eventId = this.options.ids.event();
    try {
      await this.options.localSession.appendEvent(
        `connection-diagnostic:${eventId}`,
        (sequence) => ({
          eventType: "turn-diagnostic",
          eventId,
          sequence,
          occurredAt,
          messageId: MessageIdSchema.parse("marea:connection"),
          category,
          retryable: error instanceof StudentHttpError ? error.retryable : true,
          ...failureDiagnostic(error),
          client: diagnostics.client,
        }),
      );
    } catch {
      // A run that is closing or gone keeps no more events; the local copy above remains.
    }
  }
}
