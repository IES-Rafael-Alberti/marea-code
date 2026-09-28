import { TurnFailureSignal } from "./conversation-contracts.js";
import { expect, vi } from "vitest";

import type {
  ConversationAttemptId,
  ConversationController,
  ConversationPendingTurn,
  ConversationSnapshot,
  ConversationView,
} from "./conversation-contracts.js";
import { createConversationController } from "./conversation-controller.js";

export function createConversationControllerTarget(
  onMessage: (
    text: string,
    signal: AbortSignal,
    messageId: string,
    attemptId: ConversationAttemptId,
  ) => Promise<void> = () => Promise.resolve(),
  onExit = vi.fn(),
  nextMessageId?: () => string,
  nextAttemptId?: () => ConversationAttemptId,
  initialTurn?: ConversationPendingTurn,
) {
  const snapshots: ConversationSnapshot[] = [];
  const dispose = vi.fn();
  const view: ConversationView = {
    dispose,
    render(snapshot): void {
      snapshots.push(snapshot);
    },
  };
  return {
    controller: createConversationController({
      initialTurn,
      onExit,
      onMessage,
      nextAttemptId,
      nextMessageId,
      view,
    }),
    dispose,
    onExit,
    snapshots,
  };
}

export function deferredConversationTurns() {
  const first = Promise.withResolvers<undefined>();
  const second = Promise.withResolvers<undefined>();
  const messageIds: string[] = [];
  const identities: { messageId: string; attemptId: string }[] = [];
  const operations = [first.promise, second.promise];
  const onMessage = vi.fn((...args: [string, AbortSignal, string, string]) => {
    messageIds.push(args[2]);
    identities.push({ attemptId: args[3], messageId: args[2] });
    return operations.shift() ?? second.promise;
  });
  return { first, identities, messageIds, onMessage, second };
}

export async function submitAfterFirstTurnSettles(
  controller: ConversationController,
  releaseFirst: () => void,
): Promise<void> {
  releaseFirst();
  await Promise.resolve();
  expect(controller.handle({ type: "submit", text: "Second" })).toBe(true);
}

export function temporaryTurnFailure(): TurnFailureSignal {
  return new TurnFailureSignal({
    detail: "temporary failure",
    hasPrefix: false,
    kind: "provider-interrupted",
    recoverable: true,
    retryable: true,
  });
}
