import { describe, expect, it } from "vitest";

import { NOW, query, list, addEvent, setup } from "../../../test-support/history-fixture.js";
import { student, teacher } from "../../../test-support/teaching-integration.fixture.js";

describe("authorized canonical session history", () => {
  it("reads closed runs without a lease, pages at a fixed watermark and never exposes private routes", () => {
    const { database, service, snapshot } = setup();
    try {
      const first = service.readRun(student, query());
      expect(first).toEqual({
        kind: "run-history-response",
        protocolVersion: "0.1",
        requestId: "request:history",
        runId: "run:b",
        snapshot,
        state: "closed",
        afterSequence: 0,
        throughSequence: 2,
        nextSequence: 1,
        events: [
          {
            eventType: "assistant-message",
            eventId: "event:run:b:1",
            occurredAt: NOW,
            sequence: 1,
            content: "Canonical 1",
          },
        ],
      });
      addEvent(database, "run:b", 3);
      const next = service.readRun(teacher, query("run:b", 1, first.throughSequence));
      expect(next.events.map((event) => event.sequence)).toEqual([2]);
      expect(next.nextSequence).toBeNull();
      expect(next.throughSequence).toBe(2);
      expect(JSON.stringify(next)).not.toContain("synthetic-model");
      expect(JSON.stringify(next)).not.toContain("evaluationSkills");
      expect(
        service.readRun(student, query("run:b", 2)).events.map((event) => event.sequence),
      ).toEqual([3]);
      expect(service.readRun(student, query("run:b", 3, 3)).events).toEqual([]);
      expect(service.readRun(student, query("run:a")).state).toBe("active");
      expect(() => service.readRun(student, query("run:b", 4))).toThrow("request.conflict");
      expect(() => service.readRun(student, query("run:b", 0, 4))).toThrow("request.conflict");
    } finally {
      database.close();
    }
  });

  it("denies other students, classes, missing runs and revoked teacher membership", () => {
    const { database, service } = setup();
    try {
      for (const actor of [student, teacher]) {
        for (const id of ["run:c", "run:missing"])
          expect(() => service.readRun(actor, query(id))).toThrow("run.unavailable");
        expect(() => service.listSessions(actor, list("run:c"))).toThrow("run.unavailable");
      }
      expect(() => service.readRun({ ...student, userId: "s2" }, query())).toThrow(
        "run.unavailable",
      );
      expect(() => service.readRun({ ...teacher, userId: "t2" }, query())).toThrow(
        "run.unavailable",
      );
      database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
      expect(() => service.readRun(teacher, query())).toThrow("run.unavailable");
      expect(service.listSessions(teacher, list()).runs).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("lists active and closed sessions with stable creation ordering and authorized cursors", () => {
    const { database, service } = setup();
    try {
      for (const actor of [student, teacher]) {
        const first = service.listSessions(actor, list());
        expect(first).toEqual({
          kind: "session-history-response",
          protocolVersion: "0.1",
          requestId: "request:list",
          nextBeforeRunId: "run:b",
          runs: [
            {
              runId: "run:b",
              state: "closed",
              studentDisplayName: "s1",
              classDisplayName: "one",
              projectDisplayName: "Synthetic project",
              openedAt: NOW,
              closedAt: NOW,
            },
          ],
        });
        const second = service.listSessions(actor, list("run:b"));
        expect(second.runs.map((run) => run.runId)).toEqual(["run:a"]);
        expect(second.runs[0]?.closedAt).toBeNull();
        expect(second.nextBeforeRunId).toBe("run:a");
        const third = service.listSessions(actor, list("run:a"));
        expect(third.runs.map((run) => run.runId)).toEqual(["run:older"]);
        expect(third.nextBeforeRunId).toBeNull();
        expect(service.listSessions(actor, list("run:older")).runs).toEqual([]);
      }
    } finally {
      database.close();
    }
  });

  it("rejects corrupt or gapped canonical data instead of silently skipping it", () => {
    const { database, service } = setup();
    try {
      database.execute("DELETE FROM marea_run_events WHERE run_id = 'run:b' AND sequence = 1");
      expect(() => service.readRun(student, query())).toThrow("contiguous");
      database.execute("UPDATE marea_run_events SET payload_json = '{}' WHERE run_id = 'run:a'");
      expect(() => service.readRun(student, query("run:a"))).toThrow();
      database.execute("PRAGMA ignore_check_constraints = ON");
      database.execute("UPDATE marea_runs SET state = 'corrupt' WHERE id = 'run:b'");
      expect(() => service.readRun(student, query())).toThrow("Stored run state is invalid.");
    } finally {
      database.close();
    }
  });
});

it("filters by class identity and refuses a cursor from another class", () => {
  const { database, service } = setup();
  try {
    expect(
      service.listClassSessions(teacher, { ...list(), classId: "class:one" }).runs[0]?.classId,
    ).toBe("class:one");
    expect(service.listClassSessions(teacher, { ...list(), classId: "class:two" }).runs).toEqual(
      [],
    );
    expect(
      service.listClassSessions(teacher, { ...list("run:b"), classId: "class:one" }).runs[0]?.runId,
    ).toBe("run:a");
    expect(() =>
      service.listClassSessions(teacher, { ...list("run:b"), classId: "class:two" }),
    ).toThrow("run.unavailable");
    expect(service.listClassSessions(student, { ...list(), classId: "class:two" }).runs).toEqual(
      [],
    );
  } finally {
    database.close();
  }
});

it("keeps tool details teacher-only across independent history pages without sequence gaps", () => {
  const { database, service } = setup();
  try {
    const payloads = [
      {
        eventType: "model-diagnostic",
        requestId: "request:private",
        phase: "request",
        status: "started",
        content: "PRIVATE_SKILL_CONTENT",
        truncated: false,
      },
      {
        eventType: "tool-started",
        name: "marea_read_skill",
        target: "private-evaluation.md",
        arguments: '{"path":"private-evaluation.md"}',
        truncated: false,
      },
      {
        eventType: "tool-finished",
        failed: true,
        result: "PRIVATE_SKILL_CONTENT",
        truncated: false,
      },
    ];
    for (const [index, payload] of payloads.entries()) {
      const sequence = index + 3;
      const event = {
        ...payload,
        eventId: `event:private:${String(sequence)}`,
        sequence,
        occurredAt: NOW,
        ...(payload.eventType === "model-diagnostic"
          ? {}
          : { callId: "read:private", messageId: "message:1" }),
      };
      database.execute(
        "INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json) VALUES (?1, 'run:b', ?2, ?3, ?4, ?5)",
        [event.eventId, sequence, NOW, event.eventType, JSON.stringify(event)],
      );
      expect(service.readRun(teacher, query("run:b", sequence - 1)).events).toEqual([event]);
      const studentPage = service.readRun(student, query("run:b", sequence - 1));
      expect(studentPage.events).toEqual([
        { eventId: event.eventId, sequence, occurredAt: NOW, eventType: "internal-activity" },
      ]);
      expect(JSON.stringify(studentPage)).not.toMatch(
        /PRIVATE_SKILL|private-evaluation|marea_read_skill|read:private/,
      );
      expect(() =>
        service.readRun({ ...student, userId: "s2" }, query("run:b", sequence - 1)),
      ).toThrow("run.unavailable");
    }
  } finally {
    database.close();
  }
});
