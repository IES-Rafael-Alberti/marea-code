import { describe, expect, it } from "vitest";

import {
  AppendRunEventsRequestSchema,
  AppendRunEventsResponseSchema,
  CanonicalRunEventSchema,
} from "./events.js";

const digest = `sha256:${"a".repeat(64)}`;
const eventBase = {
  eventId: "event-1",
  sequence: 1,
  occurredAt: "2026-09-03T10:00:00Z",
} as const;

const studentMessage = {
  ...eventBase,
  eventType: "student-message",
  content: "Help me make a weather app.",
} as const;

const request = {
  kind: "run-events-append",
  protocolVersion: "0.1",
  requestId: "request-events-1",
  events: [studentMessage],
} as const;

describe("canonical run event protocol", () => {
  it("parses every canonical event discriminant", () => {
    const events = [
      studentMessage,
      {
        ...eventBase,
        eventId: "event-2",
        sequence: 2,
        eventType: "assistant-message",
        content: "Start by naming the inputs.",
      },
      {
        ...eventBase,
        eventId: "event-3",
        sequence: 3,
        eventType: "approval-requested",
        approvalId: "approval-1",
        tool: "write_file",
        summary: "Create src/weather.ts",
      },
      {
        ...eventBase,
        eventId: "event-4",
        sequence: 4,
        eventType: "approval-resolved",
        approvalId: "approval-1",
        decision: "approved",
      },
      {
        ...eventBase,
        eventId: "event-5",
        sequence: 5,
        eventType: "workspace-edit",
        approvalId: "approval-1",
        operation: "created",
        path: "src/weather.ts",
        digest,
      },
      { ...eventBase, eventId: "event-6", sequence: 6, eventType: "run-activated" },
      {
        ...eventBase,
        eventId: "event-7",
        sequence: 7,
        eventType: "run-closed",
        reason: "student-exit",
      },
    ];

    const parsed = AppendRunEventsRequestSchema.parse({ ...request, events });

    expect(parsed.events.map((event) => event.eventType)).toEqual([
      "student-message",
      "assistant-message",
      "approval-requested",
      "approval-resolved",
      "workspace-edit",
      "run-activated",
      "run-closed",
    ]);
  });

  it.each(["approved", "rejected"])("accepts approval decision %s", (decision) => {
    expect(
      CanonicalRunEventSchema.parse({
        ...eventBase,
        eventType: "approval-resolved",
        approvalId: "approval-1",
        decision,
      }).eventType,
    ).toBe("approval-resolved");
  });

  it.each(["created", "updated"])("accepts workspace operation %s", (operation) => {
    expect(
      CanonicalRunEventSchema.parse({
        ...eventBase,
        eventType: "workspace-edit",
        approvalId: "approval-1",
        operation,
        path: "src/index.ts",
        digest,
      }).eventType,
    ).toBe("workspace-edit");
  });

  it("acknowledges the highest sequence durably stored", () => {
    const response = AppendRunEventsResponseSchema.parse({
      kind: "run-events-acknowledged",
      protocolVersion: "0.1",
      requestId: "request-events-1",
      highestDurableSequence: 0,
    });
    const maximum = AppendRunEventsResponseSchema.parse({
      ...response,
      highestDurableSequence: Number.MAX_SAFE_INTEGER,
    });

    expect(response.highestDurableSequence).toBe(0);
    expect(maximum.highestDurableSequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      AppendRunEventsResponseSchema.parse({ ...response, highestDurableSequence: -1 }),
    ).toThrow();
    expect(() =>
      AppendRunEventsResponseSchema.parse({
        ...response,
        highestDurableSequence: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });

  it("requires positive safe event sequences", () => {
    expect(CanonicalRunEventSchema.parse(studentMessage).sequence).toBe(1);
    expect(
      CanonicalRunEventSchema.parse({ ...studentMessage, sequence: Number.MAX_SAFE_INTEGER })
        .sequence,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => CanonicalRunEventSchema.parse({ ...studentMessage, sequence: 0 })).toThrow();
    expect(() =>
      CanonicalRunEventSchema.parse({
        ...studentMessage,
        sequence: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });

  it("requires unique event IDs and contiguous ascending sequences", () => {
    const duplicate = { ...studentMessage, sequence: 2, content: "Retry" };
    const gap = { ...studentMessage, eventId: "event-2", sequence: 3 };
    const duplicateResult = AppendRunEventsRequestSchema.safeParse({
      ...request,
      events: [studentMessage, duplicate],
    });
    const gapResult = AppendRunEventsRequestSchema.safeParse({
      ...request,
      events: [studentMessage, gap],
    });

    expect(duplicateResult).toMatchObject({
      success: false,
      error: { issues: [{ message: "Run event identifiers must be unique within a batch." }] },
    });
    expect(gapResult).toMatchObject({
      success: false,
      error: { issues: [{ message: "Run event sequences must be contiguous and ascending." }] },
    });
  });

  it("bounds an atomic event batch", () => {
    const maximum = Array.from({ length: 128 }, (_, index) => ({
      ...studentMessage,
      eventId: `event-${String(index + 1)}`,
      sequence: index + 1,
    }));
    const oversized = [...maximum, { ...studentMessage, eventId: "event-129", sequence: 129 }];

    expect(AppendRunEventsRequestSchema.parse({ ...request, events: maximum }).events).toHaveLength(
      128,
    );
    expect(() => AppendRunEventsRequestSchema.parse({ ...request, events: [] })).toThrow();
    expect(() => AppendRunEventsRequestSchema.parse({ ...request, events: oversized })).toThrow();
  });

  it("bounds event content and approval summaries", () => {
    expect(
      CanonicalRunEventSchema.parse({ ...studentMessage, content: "a".repeat(65_536) }).eventType,
    ).toBe("student-message");
    expect(() =>
      CanonicalRunEventSchema.parse({ ...studentMessage, content: "a".repeat(65_537) }),
    ).toThrow();
    expect(() => CanonicalRunEventSchema.parse({ ...studentMessage, content: "" })).toThrow();

    const approval = {
      ...eventBase,
      eventType: "approval-requested",
      approvalId: "approval-1",
      tool: "write_file",
      summary: "a".repeat(2_048),
    } as const;
    expect(CanonicalRunEventSchema.parse(approval).eventType).toBe("approval-requested");
    expect(() => CanonicalRunEventSchema.parse({ ...approval, summary: "" })).toThrow();
    expect(() =>
      CanonicalRunEventSchema.parse({ ...approval, summary: "a".repeat(2_049) }),
    ).toThrow();
  });

  it("carries bounded portable message and effect identities through durable events", () => {
    const edit = CanonicalRunEventSchema.parse({
      ...eventBase,
      approvalId: "approval-1",
      digest,
      effectId: "effect-1",
      eventType: "workspace-edit",
      messageId: "message-1",
      operation: "created",
      path: "src/index.ts",
    });

    expect(edit).toMatchObject({ effectId: "effect-1", messageId: "message-1" });
    for (const field of ["effectId", "messageId"] as const) {
      expect(() => CanonicalRunEventSchema.parse({ ...edit, [field]: "bad\nidentity" })).toThrow();
    }
  });

  it("accepts bounded relative paths and rejects escape paths", () => {
    const edit = {
      ...eventBase,
      eventType: "workspace-edit",
      approvalId: "approval-1",
      operation: "updated",
      path: "a".repeat(512),
      digest,
    } as const;

    expect(CanonicalRunEventSchema.parse(edit).eventType).toBe("workspace-edit");
    expect(() => CanonicalRunEventSchema.parse({ ...edit, path: "a".repeat(513) })).toThrow();
    expect(CanonicalRunEventSchema.safeParse({ ...edit, path: "src/.." })).toMatchObject({
      success: false,
      error: {
        issues: [{ message: "Workspace event paths must stay relative to the project root." }],
      },
    });
    for (const path of [
      "",
      ".",
      "src/.",
      "/etc/passwd",
      "../secret",
      "src/../secret",
      "src\\secret",
    ]) {
      expect(() => CanonicalRunEventSchema.parse({ ...edit, path })).toThrow();
    }
  });

  it.each(["studentId", "classId"])("rejects event authority field %s", (field) => {
    expect(() =>
      AppendRunEventsRequestSchema.parse({
        ...request,
        events: [{ ...studentMessage, [field]: "private" }],
      }),
    ).toThrow();
  });

  it("rejects private batch fields and invalid discriminants", () => {
    expect(() =>
      AppendRunEventsRequestSchema.parse({ ...request, runId: "client-forged-run" }),
    ).toThrow();
    expect(() =>
      CanonicalRunEventSchema.parse({ ...studentMessage, eventType: "provider-debug" }),
    ).toThrow();
  });
});
