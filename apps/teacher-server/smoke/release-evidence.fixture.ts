import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import {
  CanonicalRunEventSchema,
  StudentRunSnapshotSchema,
  GenerateEvaluationRequestSchema,
  ApproveEvaluationRequestSchema,
} from "@marea/protocol";
import { teachingConfiguration } from "../test-support/teaching-fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../test-support/usage-fixture.js";
import { digestSkillFiles } from "../src/teaching/skills/skill-digest.js";
import { SqliteEvaluationRepository } from "../src/platform/persistence/sqlite-evaluation-repository.js";

/** Reviewed synthetic data only: generation is completed locally without invoking a provider. */
export function seedReleaseEvidence(database: SqliteApplicationDatabase) {
  database.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('student:homonym', 'homonym', 'synthetic', 'student', 'Synthetic student', 'class:ready')",
  );
  const repository = new SqliteEvaluationRepository(database);
  const identity = {
    userId: "user:teacher",
    role: "teacher" as const,
    classId: null,
    displayName: "Synthetic Teacher",
  };
  for (const [suffix, studentId, version, approvals] of [
    ["v1", "student:release", "one", 26],
    ["v2", "student:release", "two", 1],
    ["homonym", "student:homonym", "one", 1],
    ["draft", "student:release", "one", 0],
  ] as const) {
    const runId = `run:evidence:${suffix}`,
      snapshotId = `snapshot:evidence:${suffix}`;
    const teaching = teachingConfiguration();
    const source = teaching.content.didacticSkills[0];
    if (source === undefined) throw new Error("Missing synthetic skill.");
    const content = `Synthetic ${version} skill.\n`;
    const files = [{ path: "SKILL.md", content, sizeBytes: Buffer.byteLength(content) }];
    const skill = {
      ...source,
      files,
      digest: digestSkillFiles(files),
      criteria: [
        { code: "boundary", statement: `Frozen boundary ${version}`, levels: null },
        { code: "failure", statement: `Frozen failure ${version}`, levels: null },
      ],
    };
    const now = "2026-09-22T00:00:00.000Z";
    const snapshot = StudentRunSnapshotSchema.parse({
      ...teaching.publicTemplate,
      id: snapshotId,
      didacticSkills: [{ id: skill.id, digest: skill.digest }],
    });
    database.execute(
      "INSERT INTO marea_run_snapshots (id, public_snapshot_json, provider_route_json, created_at) VALUES (?1,?2,?3,?4)",
      [
        snapshotId,
        JSON.stringify(snapshot),
        JSON.stringify({ ...teaching.providerRoute, budget: SYNTHETIC_ROUTE_BUDGET }),
        now,
      ],
    );
    database.execute(
      "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES (?1,?2)",
      [snapshotId, JSON.stringify({ ...teaching.content, didacticSkills: [skill] })],
    );
    database.execute(
      "INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at, closed_at) VALUES (?1,?2,'class:ready',?3,?1,?4,'closed',?5,?5)",
      [runId, studentId, snapshotId, `Evidence ${suffix}`, now],
    );
    const events = [
      { eventType: "run-activated" },
      { eventType: "student-message", content: "Synthetic evidence" },
      { eventType: "assistant-message", content: "Explain the boundary" },
      { eventType: "run-closed", reason: "student-exit" },
    ];
    for (const [offset, payload] of events.entries()) {
      const event = CanonicalRunEventSchema.parse({
        ...payload,
        eventId: `event:${suffix}:${String(offset)}`,
        sequence: offset + 1,
        occurredAt: now,
      });
      database.execute(
        "INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json) VALUES (?1,?2,?3,?4,?5,?6)",
        [event.eventId, runId, event.sequence, now, event.eventType, JSON.stringify(event)],
      );
    }
    for (let generation = 1; generation <= Math.max(1, approvals); generation++) {
      const id = `evaluation:${suffix}:${String(generation)}`;
      repository.queue({
        identity,
        evaluationId: id,
        now,
        request: GenerateEvaluationRequestSchema.parse({
          protocolVersion: "0.1",
          requestId: id,
          kind: "evaluation-generate",
          runId,
          expectedEvaluationId:
            generation === 1 ? null : `evaluation:${suffix}:${String(generation - 1)}`,
          idempotencyKey: id,
        }),
      });
      const claim = repository.claim("worker:synthetic", now);
      if (claim === null) throw new Error("Missing synthetic evaluation claim.");
      const draft = {
        studentFeedback: "Reviewed public feedback",
        teacherNote: "PRIVATE SYNTHETIC NOTE",
        difficulties: ["PRIVATE DIFFICULTY"],
        criteria: skill.criteria.map(({ code }) => ({
          skillId: skill.id,
          code,
          result: "passed" as const,
          confidence: "high" as const,
          evidence: `Reviewed ${version} ${code} generation ${String(generation)}`,
        })),
      };
      repository.finish(claim, draft, now);
      if (approvals > 0)
        repository.approve({
          identity,
          now,
          noticeId: `notice:${suffix}:${String(generation)}`,
          request: ApproveEvaluationRequestSchema.parse({
            protocolVersion: "0.1",
            requestId: id,
            kind: "evaluation-approve-send",
            runId,
            evaluationId: id,
            idempotencyKey: id,
            draft,
          }),
        });
    }
  }
}
