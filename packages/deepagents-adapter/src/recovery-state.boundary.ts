import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import * as z from "zod";

import {
  approvalContractChanged,
  approvalEventFor,
  approvalInterruptSchema,
  type ApprovalEvent,
} from "./approval-state.boundary.js";
import { AgentAdapterError, type AgentEvent, type AgentRecovery } from "./contracts.js";
import { isTurnInput } from "./turn-input.boundary.js";
import type {
  CheckpointTurnRecord,
  RuntimeCheckpointSaver,
} from "./durable-checkpoint.boundary.js";

const graphStateSchema = z
  .object({
    values: z.record(z.string(), z.unknown()),
    next: z.array(z.string()),
    tasks: z.array(
      z
        .object({
          interrupts: z.array(approvalInterruptSchema),
        })
        .loose(),
    ),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export interface RecoveredGraphTurn {
  readonly approval: ApprovalEvent | null;
  readonly assistantText: string;
  readonly checkpointConfig: RunnableConfig;
  readonly events: readonly AgentEvent[];
  readonly replayText: string;
  readonly type: AgentRecovery["type"];
}

type AssistantTextEvent = Extract<AgentEvent, { readonly type: "assistant-text-delta" }>;
interface ReconciledAssistantEvents {
  readonly events: readonly AssistantTextEvent[];
  readonly replayText: string;
}

export async function recoverGraphTurn(
  getState: (config: RunnableConfig) => Promise<unknown>,
  checkpointer: RuntimeCheckpointSaver,
  turn: { readonly sessionId: string; readonly messageId: string },
): Promise<RecoveredGraphTurn | null> {
  const checkpointConfig = await checkpointer.findTurnCheckpoint(turn.sessionId, turn.messageId);
  if (checkpointConfig === null) {
    const recorded = checkpointer.findTurn(turn.sessionId, turn.messageId);
    return recorded === null ? null : recoveredFromJournal(recorded, turn.sessionId);
  }
  const parsed = graphStateSchema.safeParse(await getState(checkpointConfig));
  if (!parsed.success || parsed.data.metadata?.messageId !== turn.messageId) {
    throw contractChanged();
  }
  const recorded = checkpointer.findTurn(turn.sessionId, turn.messageId);
  const textEvents = assistantEventsFor(parsed.data.values.messages, turn.messageId);
  const reconciled = reconcileGraphAndJournalEvents(textEvents, recorded);
  const interrupts = parsed.data.tasks.flatMap((task) => task.interrupts);
  const [interrupt, ...additionalInterrupts] = interrupts;
  if (additionalInterrupts.length > 0) throw contractChanged();
  if (interrupt !== undefined) {
    const approval = approvalEventFor(interrupt);
    return {
      approval,
      type: "pending-approval",
      assistantText: assistantTextFor(reconciled.events),
      checkpointConfig,
      events: [...reconciled.events, approval],
      replayText: reconciled.replayText,
    };
  }
  if (parsed.data.next.length > 0 || parsed.data.tasks.length > 0) {
    return {
      approval: approvalEventFrom(recorded),
      type: "in-progress",
      assistantText: assistantTextFor(reconciled.events),
      checkpointConfig,
      events: reconciled.events,
      replayText: reconciled.replayText,
    };
  }
  const completed = { type: "turn-completed" as const };
  return {
    approval: approvalEventFrom(recorded),
    type: "completed",
    assistantText: assistantTextFor(reconciled.events),
    checkpointConfig,
    events: [...reconciled.events, completed],
    replayText: "",
  };
}

export function isCompletedGraphState(input: unknown): boolean {
  const parsed = graphStateSchema.safeParse(input);
  if (!parsed.success) throw contractChanged();
  return parsed.data.next.length === 0 && parsed.data.tasks.length === 0;
}

function recoveredFromJournal(
  recorded: import("./durable-checkpoint.boundary.js").CheckpointTurnRecord,
  sessionId: string,
): RecoveredGraphTurn {
  const assistantEvents = recorded.events.filter(isAssistantTextEvent);
  const approval = approvalEventIn(recorded.events);
  return {
    approval,
    assistantText: assistantTextFor(assistantEvents),
    checkpointConfig: { configurable: { thread_id: sessionId } },
    events: recoveryEvents(recorded.state, assistantEvents, approval),
    replayText: recorded.state === "in-progress" ? assistantTextFor(assistantEvents) : "",
    type: recorded.state,
  };
}

function recoveryEvents(
  state: RecoveredGraphTurn["type"],
  assistantEvents: readonly AgentEvent[],
  approval: ApprovalEvent | null,
): readonly AgentEvent[] {
  if (state === "pending-approval") {
    if (approval === null) throw contractChanged();
    return [...assistantEvents, approval];
  }
  if (state === "completed") return [...assistantEvents, { type: "turn-completed" }];
  if (state === "cancelled") return [...assistantEvents, { type: "turn-cancelled" }];
  return assistantEvents;
}

function reconcileAssistantEvents(
  checkpointEvents: readonly AssistantTextEvent[],
  journalEvents: readonly AssistantTextEvent[],
): ReconciledAssistantEvents {
  const checkpointText = assistantTextFor(checkpointEvents);
  const journalText = assistantTextFor(journalEvents);
  if (checkpointText.startsWith(journalText)) {
    return { events: checkpointEvents, replayText: "" };
  }
  if (journalText.startsWith(checkpointText)) {
    return { events: journalEvents, replayText: journalText.slice(checkpointText.length) };
  }
  throw contractChanged();
}

function reconcileGraphAndJournalEvents(
  checkpointEvents: readonly AssistantTextEvent[] | null,
  recorded: CheckpointTurnRecord | null,
): ReconciledAssistantEvents {
  if (checkpointEvents === null) {
    if (recorded === null) throw contractChanged();
    const journalEvents = recorded.events.filter(isAssistantTextEvent);
    return { events: journalEvents, replayText: assistantTextFor(journalEvents) };
  }
  if (recorded === null) return { events: checkpointEvents, replayText: "" };
  return reconcileAssistantEvents(checkpointEvents, recorded.events.filter(isAssistantTextEvent));
}

function assistantEventsFor(
  input: unknown,
  messageId: string,
): readonly AssistantTextEvent[] | null {
  if (!Array.isArray(input)) return null;
  const start = input.findIndex((message) => isTurnInput(message) && message.id === messageId);
  if (start < 0) return null;
  const events: AssistantTextEvent[] = [];
  for (const message of input.slice(start + 1)) {
    if (isTurnInput(message)) break;
    if (AIMessage.isInstance(message) && message.text.length > 0) {
      events.push({ type: "assistant-text-delta", text: message.text });
    }
  }
  return events;
}

function isAssistantTextEvent(event: AgentEvent): event is AssistantTextEvent {
  return event.type === "assistant-text-delta";
}

function assistantTextFor(events: readonly AssistantTextEvent[]): string {
  return events.map((event) => event.text).join("");
}

function approvalEventIn(events: readonly AgentEvent[]): ApprovalEvent | null {
  return (
    events.find((event): event is ApprovalEvent => event.type === "tool-approval-required") ?? null
  );
}

function approvalEventFrom(recorded: CheckpointTurnRecord | null): ApprovalEvent | null {
  return recorded === null ? null : approvalEventIn(recorded.events);
}

export function recoveryAfterPrefix(
  recovered: RecoveredGraphTurn,
  persistedAssistantText: string | undefined,
): AgentRecovery {
  const prefix = persistedAssistantText ?? "";
  if (!recovered.assistantText.startsWith(prefix)) {
    throw invalidReplayPrefix();
  }
  let remaining = prefix.length;
  const events: AgentEvent[] = [];
  for (const event of recovered.events) {
    if (event.type !== "assistant-text-delta") {
      events.push(event);
      continue;
    }
    if (remaining >= event.text.length) {
      remaining -= event.text.length;
      continue;
    }
    const text = event.text.slice(remaining);
    remaining = 0;
    events.push({ type: "assistant-text-delta", text });
  }
  switch (recovered.type) {
    case "pending-approval":
      return { type: "pending-approval", assistantText: recovered.assistantText, events };
    case "in-progress":
      return { type: "in-progress", assistantText: recovered.assistantText, events };
    case "completed":
      return { type: "completed", assistantText: recovered.assistantText, events };
    case "cancelled":
      return { type: "cancelled", assistantText: recovered.assistantText, events };
  }
}

function eventsAfterPrefix(
  assistantText: string,
  events: readonly AgentEvent[],
): readonly AgentEvent[] {
  return assistantText.length === 0
    ? events
    : [{ type: "assistant-text-delta", text: assistantText }, ...events];
}

export function recordTurnWith(
  checkpointer: RuntimeCheckpointSaver,
  turn: { readonly sessionId: string; readonly messageId: string },
  assistantText: string,
) {
  return (
    state: "pending-approval" | "in-progress" | "completed",
    events: readonly AgentEvent[],
  ) => {
    const priorApproval = approvalEventFrom(checkpointer.findTurn(turn.sessionId, turn.messageId));
    const currentApproval = approvalEventIn(events);
    const completeEvents = [
      ...(assistantText.length === 0
        ? []
        : [{ type: "assistant-text-delta" as const, text: assistantText }]),
      ...(priorApproval === null || currentApproval !== null ? [] : [priorApproval]),
      ...events,
    ];
    return checkpointer.recordTurn(turn.sessionId, turn.messageId, {
      state,
      events: completeEvents,
    });
  };
}

export function cancelTurnWith(
  checkpointer: RuntimeCheckpointSaver,
  turn: { readonly sessionId: string; readonly messageId: string },
  assistantText: string,
) {
  return (events: readonly AgentEvent[]) =>
    checkpointer.cancelTurn(
      turn.sessionId,
      turn.messageId,
      eventsAfterPrefix(assistantText, events),
    );
}

export function invalidReplayPrefix(): AgentAdapterError {
  return new AgentAdapterError(
    "invalid-replay-prefix",
    "The persisted assistant text does not match the durable turn.",
  );
}

export function continuationConfig(
  base: RunnableConfig,
  checkpoint: RunnableConfig,
): RunnableConfig {
  return {
    ...base,
    configurable: { ...base.configurable, ...checkpoint.configurable },
  };
}

export function emptyBranchConfig(base: RunnableConfig, messageId: string): RunnableConfig {
  return {
    ...base,
    configurable: {
      ...base.configurable,
      checkpoint_id: `marea:unwritten:${messageId}`,
    },
  };
}

function contractChanged(): AgentAdapterError {
  return approvalContractChanged();
}
