import { describe, expect, it } from "vitest";

import {
  RunHistoryQuerySchema,
  RunHistoryResponseSchema,
  SessionHistoryItemSchema,
  SessionHistoryQuerySchema,
  SessionHistoryResponseSchema,
} from "./history.js";

const envelope = { protocolVersion: "0.1", requestId: "request:history" };
const query = {
  ...envelope,
  kind: "run-history-query",
  runId: "run:one",
  afterSequence: 0,
  limit: 1,
};
const snapshot = {
  id: "snapshot:one",
  agentMode: "free",
  modelAlias: "marea",
  didacticSkills: [],
  prompt: { version: "prompt:one", content: "Help.", digest: `sha256:${"a".repeat(64)}` },
  teacherToolPolicy: { version: "policy:one", restrictions: [] },
};
const event = {
  eventType: "run-activated",
  eventId: "event:one",
  sequence: 1,
  occurredAt: "2026-09-08T00:00:00.000Z",
};
const page = {
  ...envelope,
  kind: "run-history-response",
  runId: "run:one",
  snapshot,
  state: "active",
  afterSequence: 0,
  throughSequence: 2,
  nextSequence: 1,
  events: [event],
};
const item = {
  runId: "run:one",
  studentDisplayName: "Synthetic student",
  classDisplayName: "Synthetic class",
  projectDisplayName: "Synthetic project",
  state: "active",
  openedAt: event.occurredAt,
  closedAt: null,
};

describe("canonical history wire contract", () => {
  it("bounds queries, validates identifiers and rejects caller authority", () => {
    for (const limit of [1, 32])
      expect(RunHistoryQuerySchema.parse({ ...query, limit }).limit).toBe(limit);
    expect(RunHistoryQuerySchema.parse({ ...query, throughSequence: 0 }).throughSequence).toBe(0);
    expect(RunHistoryQuerySchema.parse({ ...query, throughSequence: 2 }).throughSequence).toBe(2);
    for (const invalid of [
      { limit: 0 },
      { limit: 33 },
      { limit: 1.5 },
      { afterSequence: -1 },
      { afterSequence: 0.5 },
      { throughSequence: -1 },
      { throughSequence: 0.5 },
      { throughSequence: 0, afterSequence: 1 },
      { runId: "bad/id" },
      { kind: "" },
      { protocolVersion: "future" },
      { requestId: "" },
      { studentId: "student:other" },
    ])
      expect(RunHistoryQuerySchema.safeParse({ ...query, ...invalid }).success).toBe(false);
    expect(() =>
      RunHistoryQuerySchema.parse({ ...query, throughSequence: 0, afterSequence: 1 }),
    ).toThrow("History cursor cannot exceed its captured boundary.");
    expect(Object.isFrozen(RunHistoryQuerySchema.parse(query))).toBe(true);
  });

  it("accepts exact contiguous pages including an empty captured history", () => {
    const parsed = RunHistoryResponseSchema.parse(page);
    expect(parsed).toEqual(page);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.events)).toBe(true);
    const final = { ...page, state: "closed", throughSequence: 1, nextSequence: null };
    expect(RunHistoryResponseSchema.parse(final)).toEqual(final);
    const empty = { ...page, afterSequence: 2, events: [], nextSequence: null };
    expect(RunHistoryResponseSchema.parse(empty)).toEqual(empty);
    const full = {
      ...page,
      throughSequence: 32,
      nextSequence: null,
      events: Array.from({ length: 32 }, (_, index) => ({
        ...event,
        eventId: `event:${String(index)}`,
        sequence: index + 1,
      })),
    };
    expect(RunHistoryResponseSchema.parse(full).events).toHaveLength(32);
    expect(
      RunHistoryResponseSchema.safeParse({
        ...full,
        throughSequence: 33,
        events: [...full.events, { ...event, sequence: 33 }],
      }).success,
    ).toBe(false);
  });

  it("rejects skipped, reversed, overflowing and falsely terminated pages", () => {
    for (const invalid of [
      { afterSequence: 3 },
      { afterSequence: -1 },
      { throughSequence: -1 },
      { nextSequence: -1 },
      { events: [{ ...event, sequence: 2 }] },
      { throughSequence: 0 },
      { nextSequence: null },
      { events: [], nextSequence: 0 },
      { nextSequence: 0 },
      { nextSequence: 2 },
      { throughSequence: 1 },
      { state: "pending" },
      { extra: true },
      { kind: "" },
      { snapshot: { ...snapshot, providerRoute: "private" } },
    ])
      expect(RunHistoryResponseSchema.safeParse({ ...page, ...invalid }).success).toBe(false);
    expect(() => RunHistoryResponseSchema.parse({ ...page, nextSequence: null })).toThrow(
      "History pages must be contiguous within their captured boundary.",
    );
  });

  it("has bounded strict session summaries with explicit nullable cursors and no private data", () => {
    const list = { ...envelope, kind: "session-history-query", limit: 50 };
    expect(SessionHistoryQuerySchema.parse(list)).toEqual(list);
    expect(
      SessionHistoryQuerySchema.parse({ ...list, limit: 1, beforeRunId: "run:one" }).beforeRunId,
    ).toBe("run:one");
    for (const invalid of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { beforeRunId: "bad/id" },
      { teacherId: "t2" },
      { kind: "" },
    ])
      expect(SessionHistoryQuerySchema.safeParse({ ...list, ...invalid }).success).toBe(false);
    expect(Object.isFrozen(SessionHistoryQuerySchema.parse(list))).toBe(true);
    expect(SessionHistoryItemSchema.parse(item)).toEqual(item);
    expect(
      SessionHistoryItemSchema.parse({ ...item, state: "closed", closedAt: item.openedAt }).state,
    ).toBe("closed");
    for (const invalid of [
      { state: "pending" },
      { privateNotes: "secret" },
      { runId: "bad/id" },
      { closedAt: "today" },
      { openedAt: "today" },
      { studentDisplayName: "" },
      { classDisplayName: "" },
      { projectDisplayName: "" },
    ])
      expect(SessionHistoryItemSchema.safeParse({ ...item, ...invalid }).success).toBe(false);
    expect(Object.isFrozen(SessionHistoryItemSchema.parse(item))).toBe(true);
    const response = {
      ...envelope,
      kind: "session-history-response",
      runs: [],
      nextBeforeRunId: null,
    };
    expect(SessionHistoryResponseSchema.parse(response)).toEqual(response);
    expect(Object.isFrozen(SessionHistoryResponseSchema.parse(response))).toBe(true);
    expect(Object.isFrozen(SessionHistoryResponseSchema.parse(response).runs)).toBe(true);
    expect(
      SessionHistoryResponseSchema.parse({
        ...response,
        runs: Array.from({ length: 50 }, () => item),
        nextBeforeRunId: "run:one",
      }).runs,
    ).toHaveLength(50);
    for (const invalid of [
      { runs: Array.from({ length: 51 }, () => item) },
      { nextBeforeRunId: "bad/id" },
      { privateRoute: "secret" },
      { kind: "" },
    ])
      expect(SessionHistoryResponseSchema.safeParse({ ...response, ...invalid }).success).toBe(
        false,
      );
  });
});
