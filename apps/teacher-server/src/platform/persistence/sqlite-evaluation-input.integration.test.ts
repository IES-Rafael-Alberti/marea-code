import { describe, expect, it, vi } from "vitest";
import { CanonicalRunEventSchema } from "@marea/protocol";

import {
  evaluationFixture,
  EVALUATION_DRAFT,
  NOW,
  teacher,
} from "../../../test-support/evaluation-fixture.js";
import { MAX_EVALUATION_INPUT_BYTES } from "../../evaluation/evaluation-input.js";
import { EvaluationWorker } from "../../evaluation/evaluation-worker.js";
import { captureEvaluationInput } from "./sqlite-evaluation-input.js";

describe("frozen evaluation capture and automatic eligibility", () => {
  it.each([0, 1])(
    "checks final serialized input at the exact byte boundary plus %s",
    (overflow) => {
      const test = evaluationFixture();
      try {
        const captured = test.database.transaction(() =>
          captureEvaluationInput(test.database, "run:b"),
        );
        if (captured.content === null) throw new Error("Expected captured input");
        expect(captured.didacticSkills).toEqual(
          captured.content.teaching.didacticSkills.map(({ id, digest }) => ({ id, digest })),
        );
        expect(captured.didacticSkills).not.toEqual([]);
        const events = [
          CanonicalRunEventSchema.parse({
            eventType: "run-activated",
            eventId: "event:first",
            sequence: 1,
            occurredAt: NOW,
          }),
          ...Array.from({ length: 129 }, (_, index) =>
            CanonicalRunEventSchema.parse({
              eventType: "assistant-message",
              eventId: `event:fill:${String(index)}`,
              sequence: index + 2,
              occurredAt: NOW,
              content: "x",
            }),
          ),
          CanonicalRunEventSchema.parse({
            eventType: "run-closed",
            eventId: "event:last",
            sequence: 131,
            occurredAt: NOW,
            reason: "student-exit",
          }),
        ];
        const input = { ...captured, content: { ...captured.content, events } };
        let remaining =
          MAX_EVALUATION_INPUT_BYTES + overflow - Buffer.byteLength(JSON.stringify(input));
        input.content.events = events.map((event) => {
          if (event.eventType !== "assistant-message") return event;
          const extra = Math.min(remaining, 65_535);
          remaining -= extra;
          return { ...event, content: "x".repeat(extra + 1) };
        });
        expect(remaining).toBe(0);
        expect(Buffer.byteLength(JSON.stringify(input))).toBe(
          MAX_EVALUATION_INPUT_BYTES + overflow,
        );
        test.database.execute("DELETE FROM marea_run_events WHERE run_id = 'run:b'");
        for (const event of input.content.events)
          test.database.execute(
            "INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json) VALUES (?1, 'run:b', ?2, ?3, ?4, ?5)",
            [event.eventId, event.sequence, NOW, event.eventType, JSON.stringify(event)],
          );
        const result = test.database.transaction(() =>
          captureEvaluationInput(test.database, "run:b"),
        );
        if (overflow === 0) expect(result).toEqual(input);
        else expect(result.content).toBeNull();
      } finally {
        test.database.close();
      }
    },
  );

  it("fails closed if the frozen content row disappears between metadata and content reads", () => {
    const test = evaluationFixture();
    try {
      const read = test.database.readOne.bind(test.database);
      vi.spyOn(test.database, "readOne").mockImplementationOnce(read).mockReturnValue(undefined);
      expect(() =>
        test.database.transaction(() => captureEvaluationInput(test.database, "run:b")),
      ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    } finally {
      test.database.close();
    }
  });
  it("queues automatically only once after opt-in closure with a selected method and conversation", () => {
    const test = evaluationFixture();
    try {
      test.database.execute("DELETE FROM marea_run_events WHERE run_id != 'run:b'");
      const createId = vi.fn(() => "evaluation:auto");
      const worker = new EvaluationWorker({
        repository: test.repository,
        clock: { now: () => NOW },
        ids: { createId },
        generator: { generate: () => Promise.resolve(EVALUATION_DRAFT) },
      });
      expect(worker.discoverClosedRuns()).toBe(0);
      expect(test.repository.queueAutomatic("run:b", "evaluation:auto", NOW)).toBeNull();
      test.database.execute(
        "UPDATE marea_run_teaching_snapshots SET teaching_json = json_set(teaching_json, '$.automaticEvaluation', json('true'))",
      );
      expect(test.repository.automaticCandidates()).toEqual(["run:b"]);
      vi.spyOn(test.repository, "queueAutomatic").mockReturnValueOnce(null);
      expect(worker.discoverClosedRuns()).toBe(0);
      expect(worker.discoverClosedRuns()).toBe(1);
      expect(createId.mock.calls).toEqual([["event"], ["event"]]);
      expect(test.database.readOne("SELECT action_owner FROM marea_evaluations")).toEqual({
        action_owner: "automatic",
      });
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({
        state: "queued",
        generation: 1,
        evaluationId: "evaluation:auto",
      });
      expect(worker.discoverClosedRuns()).toBe(0);
      expect(test.repository.queueAutomatic("run:b", "evaluation:duplicate", NOW)).toBeNull();
      expect(test.database.readAll("SELECT id FROM marea_evaluations")).toHaveLength(1);
    } finally {
      test.database.close();
    }
  });

  it.each([
    "UPDATE marea_runs SET state = 'active' WHERE id = 'run:b'",
    "UPDATE marea_run_teaching_snapshots SET teaching_json = json_set(teaching_json, '$.evaluationSkills', json('[]'))",
    "UPDATE marea_run_teaching_snapshots SET teaching_json = json_insert(teaching_json, '$.evaluationSkills[#]', json_extract(teaching_json, '$.evaluationSkills[0]'))",
    "DELETE FROM marea_run_events WHERE run_id = 'run:b' AND event_type IN ('student-message', 'assistant-message')",
  ])("does not automatically evaluate an ineligible run %#", (mutation) => {
    const test = evaluationFixture();
    try {
      test.database.execute("DELETE FROM marea_run_events WHERE run_id != 'run:b'");
      test.database.execute(
        "UPDATE marea_run_teaching_snapshots SET teaching_json = json_set(teaching_json, '$.automaticEvaluation', json('true'))",
      );
      test.database.execute(mutation);
      expect(test.repository.automaticCandidates()).toEqual([]);
      expect(test.repository.queueAutomatic("run:b", "evaluation:auto", NOW)).toBeNull();
    } finally {
      test.database.close();
    }
  });

  it.each([
    "DELETE FROM marea_run_events WHERE run_id = 'run:b'",
    "UPDATE marea_run_events SET sequence = sequence + 10 WHERE run_id = 'run:b'",
    "UPDATE marea_run_events SET payload_json = json_set(payload_json, '$.eventType', 'student-message', '$.content', 'Not an activation') WHERE run_id = 'run:b' AND sequence = 1",
    "DELETE FROM marea_run_events WHERE run_id = 'run:b' AND sequence = 1",
    "DELETE FROM marea_run_events WHERE run_id = 'run:b' AND sequence = 4",
    "DELETE FROM marea_run_events WHERE run_id = 'run:b' AND sequence = 2",
    "UPDATE marea_run_events SET payload_json = json_set(payload_json, '$.sequence', 9) WHERE run_id = 'run:b' AND sequence = 2",
    "DELETE FROM marea_run_teaching_snapshots",
    "UPDATE marea_runs SET state = 'active' WHERE id = 'run:b'",
  ])("refuses missing or noncanonical frozen input %#", (mutation) => {
    const test = evaluationFixture();
    try {
      test.database.execute(mutation);
      expect(() => test.queue()).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(test.repository.latest(teacher, "run:b")).toBeNull();
      expect(test.database.readAll("SELECT id FROM marea_evaluations")).toEqual([]);
    } finally {
      test.database.close();
    }
  });

  it("preflights oversized UTF-8 input before loading events and records a failed, untruncated manifest", () => {
    const test = evaluationFixture();
    try {
      test.database.execute(
        "UPDATE marea_run_events SET payload_json = ?1 WHERE run_id = 'run:b' AND sequence = 2",
        [JSON.stringify({ content: "€".repeat(Math.ceil(MAX_EVALUATION_INPUT_BYTES / 3)) })],
      );
      const reads = vi.spyOn(test.database, "readAll");
      const evaluation = test.queue();
      expect(evaluation).toMatchObject({ state: "failed", failure: "input-too-large" });
      expect(reads.mock.calls.some(([sql]) => sql.includes("SELECT sequence, payload_json"))).toBe(
        false,
      );
      expect(test.repository.claim("worker:one", NOW)).toBeNull();
      const stored = test.database.readOne(
        "SELECT length(input_json) AS bytes, json_extract(input_json, '$.content') AS content FROM marea_evaluations",
      );
      expect(stored?.content).toBeNull();
      expect(Number(stored?.bytes)).toBeLessThan(1_024);
    } finally {
      test.database.close();
    }
  });

  it("retains free mode and reports an absent route budget without queuing inference", () => {
    const test = evaluationFixture();
    try {
      test.database.execute(
        "UPDATE marea_run_snapshots SET public_snapshot_json = json_set(public_snapshot_json, '$.agentMode', 'free'), provider_route_json = json_remove(provider_route_json, '$.budget')",
      );
      expect(
        test.database.transaction(() => captureEvaluationInput(test.database, "run:b")).mode,
      ).toBe("free");
      expect(test.queue()).toMatchObject({ state: "failed", failure: "unconfigured" });
      expect(test.repository.claim("worker:one", NOW)).toBeNull();
    } finally {
      test.database.close();
    }
  });
});
it("keeps auxiliary streaming and model bodies out of the capture budget while retaining sequence integrity", () => {
  const test = evaluationFixture();
  try {
    test.database.transaction(() => {
      test.database.execute("DELETE FROM marea_run_events WHERE run_id = 'run:b'", []);
      const payloads = [
        { eventType: "run-activated" },
        ...Array.from({ length: 520 }, (_, index) =>
          index % 2 === 0
            ? {
                eventType: "model-diagnostic",
                requestId: "request:auxiliary",
                phase: "request",
                status: "started",
                content: "x".repeat(16384),
                truncated: false,
              }
            : {
                eventType: "assistant-progress",
                messageId: "message:auxiliary",
                content: "y".repeat(16384),
                truncated: false,
              },
        ),
        {
          eventType: "project-change",
          actor: "student",
          patch: "+student implementation",
          summary: "Student change",
          truncated: false,
        },
        { eventType: "run-closed", reason: "student-exit" },
      ];
      for (const [index, payload] of payloads.entries()) {
        const event = CanonicalRunEventSchema.parse({
          ...payload,
          eventId: `event:auxiliary:${String(index)}`,
          sequence: index + 1,
          occurredAt: NOW,
        });
        test.database.execute(
          "INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json) VALUES (?1, 'run:b', ?2, ?3, ?4, ?5)",
          [event.eventId, event.sequence, NOW, event.eventType, JSON.stringify(event)],
        );
      }
    });
    const captured = test.database.transaction(() =>
      captureEvaluationInput(test.database, "run:b"),
    );
    expect(captured.content).not.toBeNull();
    expect(captured.content?.events).toHaveLength(523);
    expect(captured.content?.events[1]).toMatchObject({
      eventType: "internal-activity",
      sequence: 2,
    });
    expect(captured.content?.events[2]).toMatchObject({
      eventType: "internal-activity",
      sequence: 3,
    });
    expect(JSON.stringify(captured)).not.toContain("x".repeat(100));
    expect(JSON.stringify(captured)).not.toContain("y".repeat(100));
    expect(JSON.stringify(captured)).toContain("+student implementation");
    test.database.execute(
      "UPDATE marea_run_events SET payload_json = json_set(payload_json, '$.sequence', 999) WHERE event_id = 'event:auxiliary:1'",
      [],
    );
    expect(() =>
      test.database.transaction(() => captureEvaluationInput(test.database, "run:b")),
    ).toThrow("request.conflict");
  } finally {
    test.database.close();
  }
});
