import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSqliteStorage, type SqliteApplicationDatabase } from "@marea/sqlite-storage";
import {
  ApproveEvaluationRequestSchema,
  CanonicalRunEventSchema,
  GenerateEvaluationRequestSchema,
  StudentRunSnapshotSchema,
} from "@marea/protocol";
import {
  SqliteEvaluationRepository,
  SqliteUsageLedger,
} from "../src/platform/persistence/index.js";
import { SqliteNoticeRepository } from "../src/platform/persistence/sqlite-notice-repository.js";
import { EvaluationDraftGenerator } from "../src/evaluation/draft-generator.boundary.js";
import { EvaluationWorker } from "../src/evaluation/evaluation-worker.js";
import { teachingConfiguration } from "../test-support/teaching-fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../test-support/usage-fixture.js";

const now = "2026-09-08T08:00:00.000Z";
const teacher = {
  userId: "t1",
  role: "teacher" as const,
  classId: null,
  displayName: "Smoke teacher",
};
const draft = {
  studentFeedback: "Reviewed feedback",
  teacherNote: "Private observation",
  difficulties: [],
  criteria: [],
};

function seed(database: SqliteApplicationDatabase): void {
  const teaching = teachingConfiguration();
  const snapshot = StudentRunSnapshotSchema.parse({
    ...teaching.publicTemplate,
    id: "snapshot:smoke",
  });
  database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:one', 'smoke', 'Smoke')",
  );
  database.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('t1', 't1', 'synthetic', 'teacher', 'Teacher', NULL), ('s1', 's1', 'synthetic', 'student', 'Student', 'class:one')",
  );
  database.execute(
    "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:one')",
  );
  database.execute(
    "INSERT INTO marea_run_snapshots (id, public_snapshot_json, provider_route_json, created_at) VALUES (?1, ?2, ?3, ?4)",
    [
      snapshot.id,
      JSON.stringify(snapshot),
      JSON.stringify({ ...teaching.providerRoute, budget: SYNTHETIC_ROUTE_BUDGET }),
      now,
    ],
  );
  database.execute(
    "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES (?1, ?2)",
    [snapshot.id, JSON.stringify(teaching.content)],
  );
  database.execute(
    "INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at, closed_at) VALUES ('run:smoke', 's1', 'class:one', ?1, 'client:smoke', 'Evaluation smoke', 'closed', ?2, ?2)",
    [snapshot.id, now],
  );
  for (const [index, payload] of [
    { eventType: "run-activated" },
    { eventType: "student-message", content: "Explain the empty-input case." },
    { eventType: "run-closed", reason: "student-exit" },
  ].entries()) {
    const event = CanonicalRunEventSchema.parse({
      ...payload,
      eventId: `event:smoke:${String(index)}`,
      sequence: index + 1,
      occurredAt: now,
    });
    database.execute(
      "INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json) VALUES (?1, 'run:smoke', ?2, ?3, ?4, ?5)",
      [event.eventId, event.sequence, now, event.eventType, JSON.stringify(event)],
    );
  }
}

const root = mkdtempSync(join(tmpdir(), "marea-evaluation-bun-"));
const databasePath = join(root, "teacher.sqlite");
let storage = initializeSqliteStorage({ databasePath });
try {
  seed(storage.database);
  const repository = new SqliteEvaluationRepository(storage.database);
  const ledger = new SqliteUsageLedger(storage.database);
  repository.queue({
    identity: teacher,
    evaluationId: "evaluation:smoke",
    now,
    request: GenerateEvaluationRequestSchema.parse({
      kind: "evaluation-generate",
      protocolVersion: "0.1",
      requestId: "request:generate",
      runId: "run:smoke",
      expectedEvaluationId: null,
      idempotencyKey: "generate:smoke",
    }),
  });
  const worker = new EvaluationWorker({
    repository,
    clock: { now: () => now },
    ids: { createId: () => "event:worker" },
    generator: new EvaluationDraftGenerator({
      ledger,
      clock: { now: () => now },
      createReservationId: () => "reservation:smoke",
      providers: {
        resolve: () => ({
          async *stream(request) {
            assert.deepEqual(request.tools, []);
            assert.match(request.messages[1]?.content ?? "", /empty-input case/u);
            await Promise.resolve();
            yield { type: "text-delta", text: JSON.stringify(draft) };
            yield { type: "usage", inputTokens: 10, outputTokens: 20 };
            yield { type: "completed", finishReason: "stop" };
          },
        }),
      },
    }),
  });
  assert.equal(await worker.runNext(new AbortController().signal), true);
  assert.equal(repository.latest(teacher, "run:smoke")?.state, "draft");
  assert.deepEqual(new SqliteNoticeRepository(storage.database).pending("s1", 32), []);
  assert.equal(ledger.totals({ runId: "run:smoke", purpose: "evaluation" }).tokens, 30);
  storage.close();
  storage = initializeSqliteStorage({ databasePath });
  const restarted = new SqliteEvaluationRepository(storage.database);
  const review = {
    identity: teacher,
    now,
    noticeId: "event:feedback",
    request: ApproveEvaluationRequestSchema.parse({
      kind: "evaluation-approve-send",
      protocolVersion: "0.1",
      requestId: "request:review",
      runId: "run:smoke",
      evaluationId: "evaluation:smoke",
      idempotencyKey: "review:smoke",
      draft,
    }),
  };
  assert.equal(restarted.approve(review).state, "approved");
  restarted.approve({ ...review, noticeId: "event:duplicate" });
  const notices = new SqliteNoticeRepository(storage.database).pending("s1", 32);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.text, draft.studentFeedback);
  assert.equal(JSON.stringify(notices).includes(draft.teacherNote), false);
  process.stdout.write(
    "Bun evaluation smoke passed: private draft, budget, restart, reviewed delivery, idempotency.\n",
  );
} finally {
  storage.close();
  rmSync(root, { recursive: true, force: true });
}
