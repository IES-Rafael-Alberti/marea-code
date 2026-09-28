import {
  ApprovalIdSchema,
  EventIdSchema,
  MessageIdSchema,
  type CanonicalRunEvent,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { StoredPendingApproval, StoredRun } from "./contracts.js";
import {
  beginStoredApproval,
  beginStoredTurn,
  finishStoredTurn,
  resolveStoredApproval,
  updateStoredTurnText,
  type EventFactory,
} from "./local-session-turns.js";
import { LocalSession } from "./local-session.js";
import { FIXTURE_CLOCK, FixtureIds, MemoryStateStore } from "./student.fixture.js";

async function activeRun(): Promise<StoredRun> {
  const session = new LocalSession(new MemoryStateStore(), new FixtureIds(), FIXTURE_CLOCK);
  const opening = await session.ensureOpening("Project One", { kind: "new" });
  return { ...opening, phase: "active" };
}

function runActivatedFactory(eventId: string): EventFactory {
  return (sequence, occurredAt): CanonicalRunEvent => ({
    eventId: EventIdSchema.parse(eventId),
    eventType: "run-activated",
    occurredAt,
    sequence,
  });
}

function pending(approvalId: string, messageId: string, suffix: string): StoredPendingApproval {
  return {
    approvalId: ApprovalIdSchema.parse(approvalId),
    content: `Content ${suffix}`,
    effectId: `effect:${suffix}`,
    messageId,
    path: `${suffix}.txt`,
    summary: `Write ${suffix}.txt`,
  };
}

describe("stored turn transitions", () => {
  it("persists one exact student event and never reopens a terminal turn", async () => {
    const run = {
      ...(await activeRun()),
      turns: [{ messageId: "message:other", state: "started" as const, text: "Unrelated" }],
    };
    const messageId = MessageIdSchema.parse("message:one");
    const event = {
      content: "Hello",
      eventId: EventIdSchema.parse("event:student-one"),
      eventType: "student-message" as const,
      messageId,
      occurredAt: FIXTURE_CLOCK.now(),
      sequence: run.nextSequence,
    };
    const started = beginStoredTurn(run, messageId, "Hello", () => event, FIXTURE_CLOCK);

    expect(started).toEqual({
      ...run,
      eventKeys: [`student:${messageId}`],
      nextSequence: run.nextSequence + 1,
      outbox: [{ key: `student:${messageId}`, value: event }],
      turns: [
        { messageId: "message:other", state: "started", text: "Unrelated" },
        { messageId, state: "started", studentText: "Hello" },
      ],
    });

    const partial = updateStoredTurnText(started, messageId, "Partial");
    expect(() =>
      beginStoredTurn(partial, messageId, "Changed", () => event, FIXTURE_CLOCK),
    ).toThrow("preserve its original student text");
    const target = partial.turns.find((turn) => turn.messageId === messageId);
    const other = partial.turns.find((turn) => turn.messageId === "message:other");
    if (target === undefined || other === undefined) throw new Error("Fixture turns missing.");
    const targetFirst = { ...partial, turns: [target, other] };
    expect(
      beginStoredTurn(
        targetFirst,
        messageId,
        "Hello",
        () => {
          throw new Error("ordered retry factory called");
        },
        FIXTURE_CLOCK,
      ).turns,
    ).toEqual(targetFirst.turns);
    expect(
      beginStoredTurn(
        partial,
        messageId,
        "Hello",
        () => {
          throw new Error("duplicate factory called");
        },
        FIXTURE_CLOCK,
      ),
    ).toEqual(partial);

    const terminal = {
      ...partial,
      turns: [
        { messageId: "message:other", state: "started" as const, text: "Unrelated" },
        { messageId, state: "completed" as const, studentText: "Hello", text: "Done" },
      ],
    };
    expect(
      beginStoredTurn(
        terminal,
        messageId,
        "Hello",
        () => {
          throw new Error("terminal factory called");
        },
        FIXTURE_CLOCK,
      ),
    ).toEqual(terminal);
  });

  it("replaces only the selected turn and omits only empty text", async () => {
    const run = {
      ...(await activeRun()),
      turns: [
        { messageId: "message:other", state: "cancelled" as const, text: "Keep" },
        { messageId: "message:one", state: "started" as const },
      ],
    };

    const withText = updateStoredTurnText(run, "message:one", "Partial answer");
    expect(withText.turns).toEqual([
      { messageId: "message:other", state: "cancelled", text: "Keep" },
      { messageId: "message:one", state: "started", text: "Partial answer" },
    ]);
    expect(updateStoredTurnText(withText, "message:one", "").turns).toEqual([
      { messageId: "message:other", state: "cancelled", text: "Keep" },
      { messageId: "message:one", state: "started" },
    ]);
    expect(updateStoredTurnText(run, "message:new", "New answer").turns).toContainEqual({
      messageId: "message:new",
      state: "started",
      text: "New answer",
    });
  });

  it("replaces only a matching pending or resolved approval", async () => {
    const run = await activeRun();
    const first = pending("approval:one", "message:one", "one");
    const second = pending("approval:two", "message:two", "two");
    const firstRequested = beginStoredApproval(
      run,
      first,
      runActivatedFactory("event:approval-one"),
      FIXTURE_CLOCK,
    );
    const bothRequested = beginStoredApproval(
      firstRequested,
      second,
      runActivatedFactory("event:approval-two"),
      FIXTURE_CLOCK,
    );
    const replacement = { ...first, content: "Replacement", path: "replacement.txt" };

    const replaced = beginStoredApproval(
      bothRequested,
      replacement,
      () => {
        throw new Error("duplicate approval factory called");
      },
      FIXTURE_CLOCK,
    );
    expect(replaced.pendingApprovals).toEqual([second, replacement]);
    expect(replaced.eventKeys).toEqual([
      "approval:approval:one:requested",
      "approval:approval:two:requested",
    ]);
    expect(replaced.nextSequence).toBe(run.nextSequence + 2);
    expect(replaced.outbox).toHaveLength(2);

    const firstResolved = resolveStoredApproval(
      run,
      { approvalId: first.approvalId, decision: "approved" },
      runActivatedFactory("event:resolved-one"),
      FIXTURE_CLOCK,
    );
    const bothResolved = resolveStoredApproval(
      firstResolved,
      { approvalId: second.approvalId, decision: "rejected" },
      runActivatedFactory("event:resolved-two"),
      FIXTURE_CLOCK,
    );
    const resolvedReplacement = resolveStoredApproval(
      bothResolved,
      { approvalId: first.approvalId, decision: "rejected" },
      () => {
        throw new Error("duplicate resolution factory called");
      },
      FIXTURE_CLOCK,
    );
    expect(resolvedReplacement.approvals).toEqual([
      { approvalId: second.approvalId, decision: "rejected" },
      { approvalId: first.approvalId, decision: "rejected" },
    ]);
    expect(resolvedReplacement.eventKeys).toEqual([
      "approval:approval:one:resolved",
      "approval:approval:two:resolved",
    ]);
    expect(resolvedReplacement.outbox).toHaveLength(2);
  });

  it("finishes one turn, emits the exact assistant sequence, and keeps unrelated approvals", async () => {
    const run = {
      ...(await activeRun()),
      nextSequence: 7,
      pendingApprovals: [
        pending("approval:target", "message:target", "target"),
        pending("approval:other", "message:other", "other"),
      ],
      turns: [
        { messageId: "message:other", state: "started" as const, text: "Keep" },
        {
          messageId: "message:target",
          state: "started" as const,
          studentText: "Original request",
          text: "Partial",
        },
      ],
    };
    const ids = new FixtureIds();
    const finished = finishStoredTurn(
      run,
      "message:target",
      "completed",
      "Partial answer",
      ids,
      FIXTURE_CLOCK,
    );

    expect(finished).toEqual({
      ...run,
      eventKeys: ["assistant:message:target"],
      nextSequence: 8,
      outbox: [
        {
          key: "assistant:message:target",
          value: {
            content: "Partial answer",
            eventId: EventIdSchema.parse("event:1"),
            eventType: "assistant-message",
            messageId: MessageIdSchema.parse("message:target"),
            occurredAt: FIXTURE_CLOCK.now(),
            sequence: 7,
          },
        },
      ],
      pendingApprovals: [pending("approval:other", "message:other", "other")],
      turns: [
        { messageId: "message:other", state: "started", text: "Keep" },
        {
          messageId: "message:target",
          state: "completed",
          studentText: "Original request",
          text: "Partial answer",
        },
      ],
    });

    const { pendingApprovals: legacyApprovals, ...legacyRun } = run;
    expect(legacyApprovals).toHaveLength(2);
    const empty = finishStoredTurn(
      legacyRun,
      "message:target",
      "cancelled",
      "",
      ids,
      FIXTURE_CLOCK,
    );
    expect(empty.eventKeys).toEqual([]);
    expect(empty.nextSequence).toBe(7);
    expect(empty.outbox).toEqual([]);
    expect(empty.pendingApprovals).toEqual([]);
    expect(empty.turns).toEqual([
      { messageId: "message:other", state: "started", text: "Keep" },
      {
        messageId: "message:target",
        state: "cancelled",
        studentText: "Original request",
      },
    ]);
    const missing = finishStoredTurn(
      { ...legacyRun, turns: [] },
      "message:missing",
      "cancelled",
      "",
      ids,
      FIXTURE_CLOCK,
    ).turns;
    expect(missing).toStrictEqual([{ messageId: "message:missing", state: "cancelled" }]);
    expect(missing[0]).not.toHaveProperty("studentText");
  });
});
