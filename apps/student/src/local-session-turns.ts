import { MessageIdSchema, STARTUP_MESSAGE_ID, type CanonicalRunEvent } from "@marea/protocol";

import type {
  Clock,
  IdSource,
  StoredApproval,
  StoredEffect,
  StoredPendingApproval,
  StoredRun,
  StoredTurn,
} from "./contracts.js";

export type EventFactory = (sequence: number, occurredAt: string) => CanonicalRunEvent;

function replaceTurn(turns: readonly StoredTurn[], replacement: StoredTurn): readonly StoredTurn[] {
  return [...turns.filter((turn) => turn.messageId !== replacement.messageId), replacement];
}

function replaceEffect(
  effects: readonly StoredEffect[],
  replacement: StoredEffect,
): readonly StoredEffect[] {
  return [...effects.filter((effect) => effect.effectId !== replacement.effectId), replacement];
}

function replacePendingApproval(
  approvals: readonly StoredPendingApproval[],
  replacement: StoredPendingApproval,
): readonly StoredPendingApproval[] {
  return [
    ...approvals.filter((approval) => approval.approvalId !== replacement.approvalId),
    replacement,
  ];
}

function withOptionalTurnText(
  turn: Pick<StoredTurn, "messageId" | "studentText" | "kind">,
  state: StoredTurn["state"],
  text: string,
): StoredTurn {
  const identity =
    turn.studentText === undefined
      ? { messageId: turn.messageId }
      : { messageId: turn.messageId, studentText: turn.studentText };
  const kind = turn.kind === "startup" ? { kind: "startup" as const } : {};
  return text.length === 0
    ? { ...identity, ...kind, state }
    : { ...identity, ...kind, state, text };
}

export function beginStoredTurn(
  run: StoredRun,
  messageId: string,
  studentText: string,
  factory: EventFactory,
  clock: Clock,
): StoredRun {
  if (messageId === STARTUP_MESSAGE_ID) throw new Error("The tutor startup identity is reserved.");
  if (run.phase !== "active") throw new Error("The student run is closed.");
  const existing = run.turns.find((turn) => turn.messageId === messageId);
  if (existing?.studentText !== undefined && existing.studentText !== studentText) {
    throw new Error("A retried message must preserve its original student text.");
  }
  const turns =
    existing === undefined
      ? [...run.turns, { messageId, state: "started" as const, studentText }]
      : existing.studentText === undefined
        ? replaceTurn(run.turns, { ...existing, studentText })
        : run.turns;
  if (run.eventKeys.includes(`student:${messageId}`)) return { ...run, turns };
  const event = factory(run.nextSequence, clock.now());
  return {
    ...run,
    eventKeys: [...run.eventKeys, `student:${messageId}`],
    nextSequence: run.nextSequence + 1,
    outbox: [...run.outbox, { key: `student:${messageId}`, value: event }],
    turns,
  };
}

export function updateStoredTurnText(run: StoredRun, messageId: string, text: string): StoredRun {
  const turn = run.turns.find((candidate) => candidate.messageId === messageId) ?? {
    messageId,
    state: "started" as const,
  };
  return {
    ...run,
    turns: replaceTurn(run.turns, withOptionalTurnText(turn, "started", text)),
  };
}

export function beginStoredApproval(
  run: StoredRun,
  replacement: StoredPendingApproval,
  factory: EventFactory,
  clock: Clock,
): StoredRun {
  const key = `approval:${replacement.approvalId}:requested`;
  if (run.eventKeys.includes(key)) {
    return {
      ...run,
      pendingApprovals: replacePendingApproval(run.pendingApprovals ?? [], replacement),
    };
  }
  const event = factory(run.nextSequence, clock.now());
  return {
    ...run,
    eventKeys: [...run.eventKeys, key],
    nextSequence: run.nextSequence + 1,
    outbox: [...run.outbox, { key, value: event }],
    pendingApprovals: replacePendingApproval(run.pendingApprovals ?? [], replacement),
  };
}

export function resolveStoredApproval(
  run: StoredRun,
  replacement: StoredApproval,
  factory: EventFactory,
  clock: Clock,
): StoredRun {
  const key = `approval:${replacement.approvalId}:resolved`;
  const approvals = [
    ...run.approvals.filter((approval) => approval.approvalId !== replacement.approvalId),
    replacement,
  ];
  if (run.eventKeys.includes(key)) return { ...run, approvals };
  const event = factory(run.nextSequence, clock.now());
  return {
    ...run,
    approvals,
    eventKeys: [...run.eventKeys, key],
    nextSequence: run.nextSequence + 1,
    outbox: [...run.outbox, { key, value: event }],
  };
}

export function recordStoredEffectAndEvent(
  run: StoredRun,
  effect: StoredEffect,
  key: string,
  factory: EventFactory,
  clock: Clock,
): StoredRun {
  const effects = replaceEffect(run.effects, effect);
  if (run.eventKeys.includes(key)) return { ...run, effects };
  const event = factory(run.nextSequence, clock.now());
  return {
    ...run,
    effects,
    eventKeys: [...run.eventKeys, key],
    nextSequence: run.nextSequence + 1,
    outbox: [...run.outbox, { key, value: event }],
  };
}

export function finishStoredTurn(
  run: StoredRun,
  messageId: string,
  state: "completed" | "cancelled",
  text: string,
  ids: IdSource,
  clock: Clock,
): StoredRun {
  const key = `assistant:${messageId}`;
  const withEvent =
    text.length === 0 || run.eventKeys.includes(key)
      ? run
      : {
          ...run,
          eventKeys: [...run.eventKeys, key],
          nextSequence: run.nextSequence + 1,
          outbox: [
            ...run.outbox,
            {
              key,
              value: {
                content: text,
                eventId: ids.event(),
                eventType: "assistant-message" as const,
                messageId: MessageIdSchema.parse(messageId),
                occurredAt: clock.now(),
                sequence: run.nextSequence,
              },
            },
          ],
        };
  return {
    ...withEvent,
    pendingApprovals: (withEvent.pendingApprovals ?? []).filter(
      (approval) => approval.messageId !== messageId,
    ),
    turns: replaceTurn(
      withEvent.turns,
      withOptionalTurnText(
        withEvent.turns.find((turn) => turn.messageId === messageId) ?? { messageId },
        state,
        text,
      ),
    ),
  };
}

export function recordStoredEffect(run: StoredRun, replacement: StoredEffect): StoredRun {
  return { ...run, effects: replaceEffect(run.effects, replacement) };
}

export function recordStoredApproval(run: StoredRun, replacement: StoredApproval): StoredRun {
  return {
    ...run,
    approvals: [
      ...run.approvals.filter((approval) => approval.approvalId !== replacement.approvalId),
      replacement,
    ],
  };
}

export function setStoredTurn(run: StoredRun, replacement: StoredTurn): StoredRun {
  return { ...run, turns: replaceTurn(run.turns, replacement) };
}
