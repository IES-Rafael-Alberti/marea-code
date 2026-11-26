import { ApprovalIdSchema, STARTUP_MESSAGE_ID, type CanonicalRunEvent } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { StoredPendingApproval, StoredTurn, TurnFailureInfo } from "./contracts.js";
import { BoundedStateStore } from "./bounded-state.fixture.js";
import { closeFailedTurnsExcept } from "./local-session-closure.js";
import { LocalSession } from "./local-session.js";
import { FIXTURE_CLOCK, FixtureIds } from "./student.fixture.js";

const FAILURE: TurnFailureInfo = {
  detail: "The model failed.",
  hasPrefix: false,
  kind: "provider-interrupted",
  recoverable: true,
  retryable: true,
};

async function openSession() {
  const store = new BoundedStateStore();
  const ids = new FixtureIds();
  const session = new LocalSession(store, ids, FIXTURE_CLOCK);
  await session.ensureOpening("Project One", { kind: "new" });
  const opening = store.state.run;
  if (opening === null) throw new Error("Fixture run missing.");
  store.state = { ...store.state, run: { ...opening, phase: "active" } };
  return { ids, session, store };
}

function seedTurns(store: BoundedStateStore, turns: readonly StoredTurn[]): void {
  const run = store.state.run;
  if (run === null) throw new Error("Fixture run missing.");
  store.state = { ...store.state, run: { ...run, turns } };
}

/** Closing a turn moves it to the end, so compare turns by identity. */
function turnStates(turns: readonly { messageId: string; state: string }[] | undefined) {
  return (turns ?? []).map((turn) => [turn.messageId, turn.state]).toSorted();
}

function messageOf(event: CanonicalRunEvent): string | undefined {
  return "messageId" in event ? event.messageId : undefined;
}

function student(ids: FixtureIds, messageId: string, content: string) {
  return (sequence: number, occurredAt: string) => ({
    content,
    eventId: ids.event(),
    eventType: "student-message" as const,
    messageId: messageId as never,
    occurredAt,
    sequence,
  });
}

function approval(approvalId: string, messageId: string): StoredPendingApproval {
  return {
    approvalId: ApprovalIdSchema.parse(approvalId),
    content: `Content of ${approvalId}`,
    effectId: `effect:${approvalId}`,
    messageId,
    path: "notes.txt",
    summary: "Write notes.txt",
  };
}

describe("failed turns superseded by a new message", () => {
  it("closes the failed turn as cancelled, tells the teacher, and keeps later failures recoverable", async () => {
    const { ids, session, store } = await openSession();
    await session.beginTurn("message:one", "First", student(ids, "message:one", "First"));
    await session.recordTurnFailure("message:one", FAILURE);

    await session.beginTurn("message:two", "Second", student(ids, "message:two", "Second"));
    await session.recordTurnFailure("message:two", FAILURE);

    const run = store.state.run;
    expect(run?.turns).toEqual([
      { messageId: "message:one", state: "cancelled", studentText: "First" },
      {
        lastFailure: FAILURE,
        messageId: "message:two",
        state: "started",
        studentText: "Second",
      },
    ]);
    expect(run?.outbox.map((event) => event.value.eventType)).toEqual([
      "student-message",
      "turn-ended",
      "student-message",
    ]);
    expect(run?.outbox[1]?.value).toMatchObject({
      eventType: "turn-ended",
      messageId: "message:one",
      state: "cancelled",
    });
    await expect(session.pendingTurn()).resolves.toMatchObject({
      failure: FAILURE,
      messageId: "message:two",
      text: "Second",
    });
  });

  it("does not close the retried message itself or a turn that has not failed", async () => {
    const { ids, session, store } = await openSession();
    await session.beginTurn("message:one", "First", student(ids, "message:one", "First"));
    await session.beginTurn("message:two", "Second", student(ids, "message:two", "Second"));
    await session.recordTurnFailure("message:two", FAILURE);

    await session.beginTurn("message:two", "Second", student(ids, "message:two", "Second"));

    expect(turnStates(store.state.run?.turns)).toEqual([
      ["message:one", "started"],
      ["message:two", "started"],
    ]);
    expect(store.state.run?.outbox.map((event) => event.value.eventType)).toEqual([
      "student-message",
      "student-message",
    ]);
  });

  it("rejects the pending write of a failed turn, once, and keeps decided approvals", async () => {
    const { ids, session, store } = await openSession();
    await session.beginTurn("message:one", "First", student(ids, "message:one", "First"));
    await session.beginApproval(
      approval("approval:open", "message:one"),
      (sequence, occurredAt) => ({
        approvalId: ApprovalIdSchema.parse("approval:open"),
        eventId: ids.event(),
        eventType: "approval-requested",
        messageId: "message:one" as never,
        occurredAt,
        sequence,
        summary: "Write notes.txt",
        tool: "write_file",
      }),
    );
    await session.beginApproval(
      approval("approval:done", "message:one"),
      (sequence, occurredAt) => ({
        approvalId: ApprovalIdSchema.parse("approval:done"),
        eventId: ids.event(),
        eventType: "approval-requested",
        messageId: "message:one" as never,
        occurredAt,
        sequence,
        summary: "Write notes.txt",
        tool: "write_file",
      }),
    );
    await session.recordApproval({
      approvalId: ApprovalIdSchema.parse("approval:done"),
      decision: "approved",
    });
    await session.recordTurnFailure("message:one", FAILURE);

    await session.beginTurn("message:two", "Second", student(ids, "message:two", "Second"));

    const run = store.state.run;
    expect(run?.pendingApprovals).toEqual([]);
    expect(run?.approvals).toEqual([
      { approvalId: "approval:done", decision: "approved" },
      {
        approvalId: "approval:open",
        decision: "rejected",
        reason: "The student moved on before this write was answered.",
      },
    ]);
    const resolved = run?.outbox.filter((event) => event.value.eventType === "approval-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved?.[0]?.value).toMatchObject({
      approvalId: "approval:open",
      decision: "rejected",
      effectId: "effect:approval:open",
      messageId: "message:one",
    });
  });

  it("leaves a finished turn alone even if it still carries an old failure", async () => {
    const { ids, session, store } = await openSession();
    seedTurns(store, [{ lastFailure: FAILURE, messageId: "message:old", state: "completed" }]);

    await session.beginTurn("message:one", "First", student(ids, "message:one", "First"));

    expect(store.state.run?.turns[0]).toMatchObject({
      messageId: "message:old",
      state: "completed",
    });
    expect(store.state.run?.outbox.map((entry) => entry.value.eventType)).toEqual([
      "student-message",
    ]);
  });

  it("closes a failed tutor startup with its own cancelled progress event", async () => {
    const { ids, session, store } = await openSession();
    seedTurns(store, [
      { kind: "startup", lastFailure: FAILURE, messageId: STARTUP_MESSAGE_ID, state: "started" },
    ]);

    await session.beginTurn("message:one", "First", student(ids, "message:one", "First"));

    expect(store.state.run?.turns[0]).toMatchObject({ kind: "startup", state: "cancelled" });
    expect(store.state.run?.outbox.map((event) => event.value.eventType)).toEqual([
      "tutor-startup",
      "student-message",
    ]);
    expect(store.state.run?.outbox[0]?.value).toMatchObject({ state: "cancelled" });
  });
});

describe("several pending turns at startup", () => {
  async function withTurns(
    turns: readonly { id: string; failed?: boolean }[],
    approvals: readonly StoredPendingApproval[] = [],
  ) {
    const fixture = await openSession();
    const run = fixture.store.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    fixture.store.state = {
      ...fixture.store.state,
      run: {
        ...run,
        pendingApprovals: approvals,
        turns: turns.map((turn) => ({
          ...(turn.failed === true ? { lastFailure: FAILURE } : {}),
          messageId: turn.id,
          state: "started" as const,
          studentText: `Text of ${turn.id}`,
        })),
      },
    };
    return fixture;
  }

  it("keeps the most recent turn and closes the others", async () => {
    const { session, store } = await withTurns([
      { id: "message:one", failed: true },
      { id: "message:two", failed: true },
      { id: "message:three", failed: true },
    ]);

    await expect(session.pendingTurn()).resolves.toMatchObject({ messageId: "message:three" });

    expect(turnStates(store.state.run?.turns)).toEqual([
      ["message:one", "cancelled"],
      ["message:three", "started"],
      ["message:two", "cancelled"],
    ]);
    expect(
      store.state.run?.outbox.map((event) => [event.value.eventType, messageOf(event.value)]),
    ).toEqual([
      ["turn-ended", "message:one"],
      ["turn-ended", "message:two"],
    ]);
    const saves = store.saves;
    await session.pendingTurn();
    expect(store.saves).toBe(saves);
  });

  it("never drops the turn that waits on a write approval", async () => {
    const { session, store } = await withTurns(
      [
        { id: "message:one", failed: true },
        { id: "message:two", failed: true },
      ],
      [approval("approval:one", "message:one")],
    );

    await expect(session.pendingTurn()).resolves.toMatchObject({ messageId: "message:one" });

    expect(turnStates(store.state.run?.turns)).toEqual([
      ["message:one", "started"],
      ["message:two", "cancelled"],
    ]);
    expect(store.state.run?.pendingApprovals).toHaveLength(1);
  });

  it("rejects the approvals of the turns it closes", async () => {
    const { session, store } = await withTurns(
      [{ id: "message:one" }, { id: "message:two" }, { id: "message:three" }],
      [approval("approval:one", "message:one"), approval("approval:two", "message:two")],
    );

    await expect(session.pendingTurn()).resolves.toMatchObject({ messageId: "message:two" });

    expect(store.state.run?.pendingApprovals?.map((entry) => entry.approvalId)).toEqual([
      "approval:two",
    ]);
    expect(
      store.state.run?.outbox
        .filter((event) => event.value.eventType === "approval-resolved")
        .map((event) => messageOf(event.value)),
    ).toEqual(["message:one"]);
    expect(turnStates(store.state.run?.turns)).toEqual([
      ["message:one", "cancelled"],
      ["message:three", "cancelled"],
      ["message:two", "started"],
    ]);
  });

  it("is a no-op without a run and for runs that are not active", async () => {
    const empty = new LocalSession(new BoundedStateStore(), new FixtureIds(), FIXTURE_CLOCK);
    await expect(empty.pendingTurn()).resolves.toBeNull();
    const { session, store } = await openSession();
    const run = store.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    store.state = { ...store.state, run: { ...run, phase: "closing" } };
    await expect(session.pendingTurn()).resolves.toBeNull();
  });
});

describe("closing a run saved without pending approvals", () => {
  it("closes the failed turn of a legacy run", async () => {
    const { ids, session, store } = await openSession();
    await session.beginTurn("message:one", "First", student(ids, "message:one", "First"));
    await session.recordTurnFailure("message:one", FAILURE);
    const run = store.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    const { pendingApprovals, ...legacy } = run;
    expect(pendingApprovals).toEqual([]);
    store.state = { ...store.state, run: legacy };

    expect(closeFailedTurnsExcept(legacy, "message:two", ids, FIXTURE_CLOCK).turns[0]?.state).toBe(
      "cancelled",
    );
  });
});
