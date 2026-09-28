import type { AgentRuntime, AgentEvent } from "./contracts.js";
import type { ActiveRun } from "./session-turn-executor.js";
import type { SessionTurnExecutorOptions, StableTurnIdentity } from "./session-turn-executor.js";
import { TeacherActivity } from "./teacher-activity.js";
import { TurnAttemptFailed } from "./contracts.js";
import { attemptFailure, classifyTurnFailure } from "./turn-failure.boundary.js";

export async function finishTurn(
  options: SessionTurnExecutorOptions,
  identity: StableTurnIdentity,
  outcome: { readonly state: "completed" | "cancelled"; readonly text: string },
): Promise<void> {
  await options.evidence?.capture("student", identity.messageId);
  await options.localSession.finishTurn(identity.messageId, outcome.state, outcome.text);
  await new TeacherActivity(options).terminal(identity, {
    eventType: "turn-ended",
    state: outcome.state,
  });
  await options.flushOutbox();
  options.studentInterface.present({ ...identity, type: `turn-${outcome.state}` });
}

export async function failTurn(
  options: SessionTurnExecutorOptions,
  identity: StableTurnIdentity,
  initialText: string,
  signal: AbortSignal,
  error: unknown,
): Promise<void> {
  const current = await options.localSession.findTurn(identity.messageId);
  if (!signal.aborted) {
    const failed = error instanceof TurnAttemptFailed ? error : attemptFailure(initialText, error);
    if (current?.state === "started") {
      const failure = classifyTurnFailure(failed);
      await options.localSession.recordTurnFailure(identity.messageId, failure);
      await new TeacherActivity(options).terminal(identity, {
        eventType: "turn-failed",
        category: failure.kind,
        retryable: failure.retryable,
      });
    }
    // Delivery can be offline; keep the original failure and durable outbox.
    await options.flushOutbox().catch(() => undefined);
    throw failed;
  }
  await options.localSession.finishTurn(
    identity.messageId,
    "cancelled",
    current?.text ?? initialText,
  );
  await new TeacherActivity(options).terminal(identity, {
    eventType: "turn-ended",
    state: "cancelled",
  });
  options.studentInterface.present({ ...identity, type: "turn-cancelled" });
  // Cancellation stops effects immediately; its audit delivery must neither
  // delay the UI nor wait for another student turn to reach the teacher.
  void options.flushOutbox().catch(() => undefined);
}
export function startupStream(
  agent: AgentRuntime,
  active: ActiveRun,
  messageId: string,
  assistantText: string,
  signal: AbortSignal,
): AsyncIterable<AgentEvent> {
  if (agent.streamStartup === undefined)
    throw new Error("The agent does not support internal tutor startup.");
  return agent.streamStartup(
    { runId: active.runId, snapshot: active.snapshot, messageId, assistantText },
    signal,
  );
}
