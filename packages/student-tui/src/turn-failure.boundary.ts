import { TurnFailureSignal, type TurnFailureInfo } from "./conversation-contracts.js";

/**
 * Extracts a classified turn failure from a rejected turn operation. Only
 * the carrier the application threw carries one; any other rejection means
 * an unclassified driver failure, which the presentation renders with its
 * generic message.
 */
export function failureFromRejection(reason: unknown): TurnFailureInfo | undefined {
  return reason instanceof TurnFailureSignal ? reason.failure : undefined;
}

/**
 * Settles a turn operation through its classifier. One subscription handles
 * both outcomes, so no derived rejection is left unhandled. The rejection
 * callback lives here so the reason is parsed at the boundary.
 */
export function trackTurnOperation(
  operation: Promise<void>,
  onFulfilled: () => void,
  onRejected: (failure: TurnFailureInfo | undefined) => void,
): void {
  void operation.then(onFulfilled, (reason: unknown) => {
    onRejected(failureFromRejection(reason));
  });
}
