import { RequestIdSchema } from "@marea/protocol";

import type { TurnAttemptFailed, TurnFailureInfo } from "./contracts.js";
import type { FailureLog } from "./failure-log.boundary.js";
import type { SessionTurnExecutorOptions, StableTurnIdentity } from "./session-turn-executor.js";
import { failureDiagnostic } from "./turn-diagnostics.boundary.js";

export interface TurnDiagnosticsOptions {
  /** True once the teacher server announced `marea.runs.turn-diagnostics`. */
  readonly reportToServer: () => boolean;
  readonly client: { readonly version: string; readonly platform: string };
  readonly log?: FailureLog | undefined;
  /** The last model exchange of this session, as recorded by the diagnostic gateway. */
  readonly lastModelResponse?: () => {
    readonly requestId: string;
    readonly content: string;
  } | null;
}

/**
 * Records the technical detail of a failed attempt: always in the private local log, and with
 * the session on servers that store it. Diagnostics never change the failure itself.
 */
export async function reportTurnDiagnostic(
  options: SessionTurnExecutorOptions,
  identity: StableTurnIdentity,
  error: TurnAttemptFailed,
  failure: TurnFailureInfo,
  category: string,
): Promise<void> {
  const diagnostics = options.diagnostics;
  if (diagnostics === undefined) return;
  const model = diagnostics.lastModelResponse?.() ?? null;
  const requestId = RequestIdSchema.safeParse(model?.requestId);
  const payload = {
    category,
    retryable: failure.retryable,
    ...failureDiagnostic(error),
    client: diagnostics.client,
    ...(requestId.success ? { requestId: requestId.data } : {}),
    ...(model === null ? {} : { modelResponse: model.content.slice(0, 16_384) }),
  };
  try {
    await diagnostics.log?.append({
      occurredAt: new Date().toISOString(),
      messageId: identity.messageId,
      attemptId: identity.attemptId,
      ...payload,
    });
  } catch {
    // The local copy is best effort; it never changes the failure being reported.
  }
  if (!diagnostics.reportToServer()) return;
  await options.localSession.appendEvent(
    JSON.stringify([identity.messageId, identity.attemptId, "turn-diagnostic"]),
    (sequence, occurredAt) => ({
      eventType: "turn-diagnostic",
      eventId: options.ids.event(),
      sequence,
      occurredAt,
      messageId: identity.messageId,
      ...payload,
    }),
  );
}
