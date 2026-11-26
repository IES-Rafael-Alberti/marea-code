/* eslint-disable @typescript-eslint/require-await -- Fixture streams yield without awaiting. */
import { ApprovalIdSchema, MessageIdSchema, type CanonicalRunEvent } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { AgentEvent, StoredEvent, StoredRun } from "./contracts.js";
import { BoundedStateStore } from "./bounded-state.fixture.js";
import { acknowledgeStored, pruneEventKeys } from "./local-session-keys.js";
import { LocalSession } from "./local-session.js";
import { FIXTURE_CLOCK, FixtureIds } from "./student.fixture.js";
import { TeacherActivity } from "./teacher-activity.js";
import { turnEndedKey } from "./turn-keys.js";

async function* agentEvents(turn: number): AsyncIterable<AgentEvent> {
  for (const call of ["a", "b", "c", "d", "e", "f"]) {
    const callId = `call:${String(turn)}:${call}`;
    yield { type: "tool-started", callId, name: "read_file", arguments: { path: "notes.txt" } };
    yield { type: "tool-finished", callId, failed: false, result: "ok" };
  }
}

describe("event key retention in a long session", () => {
  it("keeps the saved state valid across hundreds of tool-heavy turns", async () => {
    const store = new BoundedStateStore();
    const ids = new FixtureIds();
    const session = new LocalSession(store, ids, FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    const opening = store.state.run;
    if (opening === null) throw new Error("Fixture run missing.");
    store.state = { ...store.state, run: { ...opening, phase: "active" } };
    const activity = new TeacherActivity({
      flushOutbox: () => Promise.resolve(),
      ids,
      localSession: session,
    });

    for (let turn = 0; turn < 300; turn += 1) {
      const messageId = MessageIdSchema.parse(`message:${String(turn)}`);
      const identity = { attemptId: "attempt:1", messageId };
      await session.beginTurn(messageId, "Question", (sequence, occurredAt) => ({
        content: "Question",
        eventId: ids.event(),
        eventType: "student-message",
        messageId,
        occurredAt,
        sequence,
      }));
      await Array.fromAsync(activity.observe(agentEvents(turn), identity, () => ""));
      await session.finishTurn(messageId, "completed", "Answer");
      await activity.terminal(identity, { eventType: "turn-ended", state: "completed" });
      await session.prepareDelivery(128);
      await session.acknowledge(store.state.run?.nextSequence ?? 0);
    }

    const keys = store.state.run?.eventKeys ?? [];
    expect(keys).toHaveLength(300);
    expect(keys.every((key) => key === turnEndedKey(key.slice(2, key.indexOf('"', 2))))).toBe(true);
  }, 60_000);
});

it("keeps the start and the end of one tool call as two undelivered events", async () => {
  const store = new BoundedStateStore();
  const ids = new FixtureIds();
  const session = new LocalSession(store, ids, FIXTURE_CLOCK);
  await session.ensureOpening("Project One", { kind: "new" });
  const activity = new TeacherActivity({
    flushOutbox: () => Promise.resolve(),
    ids,
    localSession: session,
  });
  const identity = { attemptId: "attempt:1", messageId: MessageIdSchema.parse("message:one") };

  await Array.fromAsync(activity.observe(agentEvents(0), identity, () => ""));

  const types = store.state.run?.outbox.map((entry) => entry.value.eventType) ?? [];
  expect(types.filter((type) => type === "tool-started")).toHaveLength(6);
  expect(types.filter((type) => type === "tool-finished")).toHaveLength(6);
  expect(new Set(store.state.run?.eventKeys).size).toBe(12);
});

function event(sequence: number, eventType: CanonicalRunEvent["eventType"]): StoredEvent {
  return {
    key: `key:${String(sequence)}`,
    value: {
      eventId: `event:${String(sequence)}`,
      eventType,
      occurredAt: FIXTURE_CLOCK.now(),
      sequence,
    } as never,
  };
}

async function runWith(overrides: Partial<StoredRun>): Promise<StoredRun> {
  const session = new LocalSession(new BoundedStateStore(), new FixtureIds(), FIXTURE_CLOCK);
  const run = await session.ensureOpening("Project One", { kind: "new" });
  return { ...run, ...overrides };
}

describe("pruneEventKeys", () => {
  it("keeps keys of undelivered events, run-level keys and terminal keys of known turns", async () => {
    const run = await runWith({
      eventKeys: [
        "queued",
        "queued-in-delivery",
        "project-context",
        "startup:started",
        turnEndedKey("message:done"),
        turnEndedKey("message:gone"),
        "unowned",
      ],
      outbox: [event(1, "run-activated")].map((entry) => ({ ...entry, key: "queued" })),
      pendingDelivery: {
        events: [{ ...event(2, "run-activated"), key: "queued-in-delivery" }],
      },
      turns: [{ messageId: "message:done", state: "completed" }],
    });

    expect(pruneEventKeys(run).eventKeys).toEqual([
      "queued",
      "queued-in-delivery",
      "project-context",
      "startup:started",
      turnEndedKey("message:done"),
    ]);
  });

  it("keeps the keys of an open turn and of run-level events while a turn is open", async () => {
    const approvalKey = `approval:${ApprovalIdSchema.parse("approval:1")}:requested`;
    const run = await runWith({
      eventKeys: [
        "student:message:open",
        "assistant:message:open",
        JSON.stringify(["message:open", "attempt:1", "start:call"]),
        JSON.stringify(["message:closed", "attempt:1", "start:call"]),
        "student:message:closed",
        "assistant:message:closed",
        approvalKey,
        "not-json-[",
        "[]",
        "[1]",
      ],
      turns: [
        { messageId: "message:open", state: "started" },
        { messageId: "message:closed", state: "completed" },
      ],
    });

    expect(pruneEventKeys(run).eventKeys).toEqual([
      "student:message:open",
      "assistant:message:open",
      JSON.stringify(["message:open", "attempt:1", "start:call"]),
      approvalKey,
      "not-json-[",
      "[]",
      "[1]",
    ]);
  });

  it("drops every unowned key once no turn is open", async () => {
    const run = await runWith({
      eventKeys: ["student:message:closed", "approval:approval:1:resolved", "model:request:1"],
      turns: [{ messageId: "message:closed", state: "cancelled" }],
    });

    expect(pruneEventKeys(run).eventKeys).toEqual([]);
  });

  it("keeps only the sixteen latest project-change keys", async () => {
    const changes = Array.from({ length: 20 }, (_, index) => `project-change:${String(index)}`);
    const run = await runWith({ eventKeys: changes });

    expect(pruneEventKeys(run).eventKeys).toEqual(changes.slice(4));
  });

  it("returns the same run when nothing is dropped", async () => {
    const run = await runWith({ eventKeys: ["project-context"] });

    expect(pruneEventKeys(run)).toBe(run);
  });

  it("drops the keys of delivered observational events even while their turn is open", async () => {
    const run = await runWith({
      eventKeys: ["key:1", "key:2", "key:3"],
      turns: [{ messageId: "message:open", state: "started" }],
    });
    const delivered = [
      event(1, "tool-started"),
      event(2, "student-message"),
      event(3, "model-diagnostic"),
    ];

    expect(pruneEventKeys(run, delivered).eventKeys).toEqual(["key:2"]);
    for (const eventType of ["assistant-progress", "tool-finished", "turn-diagnostic"] as const) {
      expect(
        pruneEventKeys({ ...run, eventKeys: ["key:1"] }, [event(1, eventType)]).eventKeys,
      ).toEqual([]);
    }
  });
});

describe("acknowledgeStored", () => {
  it("removes delivered events and clears an emptied delivery envelope", async () => {
    const events = [
      event(1, "run-activated"),
      event(2, "run-activated"),
      event(3, "run-activated"),
    ];
    const run = await runWith({
      eventKeys: ["key:1", "key:2", "key:3"],
      outbox: events,
      pendingDelivery: { events: events.slice(0, 2) },
      turns: [{ messageId: "message:open", state: "started" }],
    });

    const partial = acknowledgeStored(run, 1);
    expect(partial.outbox.map((entry) => entry.value.sequence)).toEqual([2, 3]);
    expect(partial.pendingDelivery?.events.map((entry) => entry.value.sequence)).toEqual([2]);
    expect(partial.eventKeys).toEqual(["key:1", "key:2", "key:3"]);

    const complete = acknowledgeStored(run, 3);
    expect(complete.outbox).toEqual([]);
    expect(complete.pendingDelivery).toBeNull();
    expect(acknowledgeStored({ ...run, pendingDelivery: null }, 1).pendingDelivery).toBeNull();
  });
});
