import {
  ApproveEvaluationRequestSchema,
  CanonicalRunEventSchema,
  EvaluationDraftSchema,
  GenerateEvaluationRequestSchema,
} from "@marea/protocol";

import { setup, NOW } from "./history-fixture.js";
import { teachingConfiguration } from "./teaching-fixture.js";
import { teacher } from "./teaching-integration.fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "./usage-fixture.js";
import { SqliteEvaluationRepository } from "../src/platform/persistence/sqlite-evaluation-repository.js";

export { NOW, teacher };
export const EVALUATION_DRAFT = EvaluationDraftSchema.parse({
  studentFeedback: "You explained a boundary. Try one failure case next.",
  teacherNote: "Private pedagogical observation.",
  difficulties: ["The failure case was not justified."],
  criteria: [],
});

export function evaluationRequest(expectedEvaluationId: string | null = null, key = "generate:1") {
  return GenerateEvaluationRequestSchema.parse({
    kind: "evaluation-generate",
    protocolVersion: "0.1",
    requestId: "request:evaluation",
    runId: "run:b",
    expectedEvaluationId,
    idempotencyKey: key,
  });
}

export function reviewRequest(evaluationId = "evaluation:1") {
  return ApproveEvaluationRequestSchema.parse({
    kind: "evaluation-approve-send",
    protocolVersion: "0.1",
    requestId: "request:review",
    runId: "run:b",
    evaluationId,
    idempotencyKey: "review:1",
    draft: EVALUATION_DRAFT,
  });
}

export function evaluationFixture(databasePath?: string) {
  const base = setup(databasePath);
  const configuration = teachingConfiguration();
  base.database.execute(
    "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES (?1, ?2)",
    [base.snapshot.id, JSON.stringify(configuration.content)],
  );
  base.database.execute("UPDATE marea_run_snapshots SET provider_route_json = ?1", [
    JSON.stringify({ ...configuration.providerRoute, budget: SYNTHETIC_ROUTE_BUDGET }),
  ]);
  base.database.execute("DELETE FROM marea_run_events WHERE run_id = 'run:b'");
  const payloads = [
    { eventType: "run-activated" },
    { eventType: "student-message", content: "Let us test an empty input." },
    { eventType: "assistant-message", content: "What should it return?" },
    { eventType: "run-closed", reason: "student-exit" },
  ];
  for (const [index, payload] of payloads.entries()) {
    const event = CanonicalRunEventSchema.parse({
      ...payload,
      sequence: index + 1,
      eventId: `event:evaluation:${String(index)}`,
      occurredAt: NOW,
    });
    base.database.execute(
      `INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json)
        VALUES (?1, 'run:b', ?2, ?3, ?4, ?5)`,
      [event.eventId, event.sequence, NOW, event.eventType, JSON.stringify(event)],
    );
  }
  const repository = new SqliteEvaluationRepository(base.database);
  return {
    ...base,
    repository,
    queue: () =>
      repository.queue({
        identity: teacher,
        request: evaluationRequest(),
        evaluationId: "evaluation:1",
        now: NOW,
      }),
  };
}
