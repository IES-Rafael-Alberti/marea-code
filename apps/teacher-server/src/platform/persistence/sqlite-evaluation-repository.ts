import {
  EvaluationFailureSchema,
  type EvaluationDraft,
  type EvaluationFailure,
  type TeacherEvaluation,
} from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import type {
  EvaluationClaim,
  EvaluationRepository,
  QueueEvaluationInput,
  ReviewEvaluationInput,
} from "../../evaluation/contracts.js";
import { evaluationDigest, type EvaluationInput } from "../../evaluation/evaluation-input.js";
import { validateEvaluationDraft } from "../../evaluation/validate-draft.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { activeGovernanceMembership } from "./governance-access-sql.js";
import { rowInteger, rowText } from "./row-parser.boundary.js";
import { captureEvaluationInput } from "./sqlite-evaluation-input.js";
import { evaluationRecord, storedEvaluationInput } from "./sqlite-evaluation-record.js";
import { publishNoticeInTransaction } from "./sqlite-notice-repository.js";

function conflict(): never {
  throw new TeacherDomainError("request.conflict");
}

const AUTOMATIC_ELIGIBILITY = `runs.state = 'closed'
  AND json_extract(teaching.teaching_json, '$.automaticEvaluation') = 1
  AND json_array_length(teaching.teaching_json, '$.evaluationSkills') = 1
  AND EXISTS (SELECT 1 FROM marea_run_events WHERE run_id = runs.id
    AND event_type IN ('student-message', 'assistant-message'))
  AND NOT EXISTS (SELECT 1 FROM marea_evaluations WHERE run_id = runs.id)`;

export class SqliteEvaluationRepository implements EvaluationRepository {
  public constructor(private readonly database: SqliteApplicationDatabase) {}

  public automaticCandidates(): readonly string[] {
    return this.database
      .readAll(
        `SELECT runs.id FROM marea_runs runs
        JOIN marea_run_teaching_snapshots teaching ON teaching.snapshot_id = runs.snapshot_id
        WHERE ${AUTOMATIC_ELIGIBILITY} ORDER BY runs.closed_at, runs.id LIMIT 32`,
      )
      .map((row) => rowText(row, "id"));
  }

  public queueAutomatic(
    runId: string,
    evaluationId: string,
    now: string,
  ): TeacherEvaluation | null {
    return this.database.transaction(() => {
      const row = this.database.readOne(
        `SELECT runs.id FROM marea_runs runs
          JOIN marea_run_teaching_snapshots teaching ON teaching.snapshot_id = runs.snapshot_id
          WHERE runs.id = ?1 AND ${AUTOMATIC_ELIGIBILITY}`,
        [runId],
      );
      if (row === undefined) return null;
      return this.insert({
        captured: captureEvaluationInput(this.database, runId),
        evaluationId,
        now,
        owner: "automatic",
        key: runId,
        fingerprint: evaluationDigest(runId),
        generation: 1,
      });
    });
  }

  public latest(identity: AuthenticatedIdentity, runId: string): TeacherEvaluation | null {
    return this.database.transaction(() => {
      this.requireAccess(identity, runId);
      const row = this.latestRow(runId);
      return row === undefined ? null : evaluationRecord(row);
    });
  }

  public queue(input: QueueEvaluationInput): TeacherEvaluation {
    return this.database.transaction(() => {
      const { identity, request, evaluationId, now } = input;
      this.requireAccess(identity, request.runId);
      const fingerprint = evaluationDigest(
        JSON.stringify([request.runId, request.expectedEvaluationId]),
      );
      const owner = `teacher:${identity.userId}`;
      const previous = this.database.readOne(
        "SELECT * FROM marea_evaluations WHERE action_owner = ?1 AND action_key = ?2",
        [owner, request.idempotencyKey],
      );
      if (previous !== undefined) {
        if (rowText(previous, "request_fingerprint") !== fingerprint) conflict();
        return evaluationRecord(previous);
      }
      const latest = this.latestRow(request.runId);
      if ((latest === undefined ? null : rowText(latest, "id")) !== request.expectedEvaluationId)
        conflict();
      if (latest !== undefined && ["queued", "running"].includes(rowText(latest, "state")))
        conflict();
      const captured =
        latest === undefined
          ? captureEvaluationInput(this.database, request.runId)
          : storedEvaluationInput(latest);
      return this.insert({
        captured,
        evaluationId,
        now,
        owner,
        key: request.idempotencyKey,
        fingerprint,
        generation: latest === undefined ? 1 : rowInteger(latest, "generation") + 1,
      });
    });
  }

  public claim(workerToken: string, now: string): EvaluationClaim | null {
    return this.database.transaction(() => {
      const row = this.database.readOne(
        "SELECT * FROM marea_evaluations WHERE state = 'queued' ORDER BY created_at, id LIMIT 1",
      );
      if (row === undefined) return null;
      const input = storedEvaluationInput(row);
      const evaluationId = rowText(row, "id");
      this.database.execute(
        "UPDATE marea_evaluations SET state = 'running', worker_token = ?2, updated_at = ?3 WHERE id = ?1",
        [evaluationId, workerToken, now],
      );
      return { evaluationId, workerToken, input };
    });
  }

  public finish(
    claim: EvaluationClaim,
    result: EvaluationDraft | EvaluationFailure,
    now: string,
  ): void {
    this.database.transaction(() => {
      const row = this.database.readOne(
        "SELECT * FROM marea_evaluations WHERE id = ?1 AND worker_token = ?2 AND state = 'running'",
        [claim.evaluationId, claim.workerToken],
      );
      if (row === undefined) conflict();
      const input = storedEvaluationInput(row);
      let draft: EvaluationDraft | null = null;
      let failure: EvaluationFailure | null = null;
      if (typeof result === "string") failure = EvaluationFailureSchema.parse(result);
      else {
        if (input.content === null) conflict();
        draft = validateEvaluationDraft(result, input.mode, input.content.teaching.didacticSkills);
      }
      this.database.execute(
        `UPDATE marea_evaluations SET state = ?2, draft_json = ?3, failure_code = ?4,
          worker_token = NULL, updated_at = ?5 WHERE id = ?1`,
        [
          claim.evaluationId,
          draft === null ? "failed" : "draft",
          draft === null ? null : JSON.stringify(draft),
          failure,
          now,
        ],
      );
    });
  }

  public recoverInterrupted(now: string): void {
    this.database.execute(
      `UPDATE marea_evaluations SET state = 'failed', failure_code = 'interrupted',
        worker_token = NULL, updated_at = ?1 WHERE state = 'running'`,
      [now],
    );
  }

  public approve(input: ReviewEvaluationInput): TeacherEvaluation {
    return this.database.transaction(() => {
      const { identity, request, now, noticeId } = input;
      this.requireAccess(identity, request.runId);
      const row = this.latestRow(request.runId);
      if (row === undefined || rowText(row, "id") !== request.evaluationId) conflict();
      const fingerprint = evaluationDigest(JSON.stringify(request.draft));
      const state = rowText(row, "state");
      if (state === "approved") {
        if (
          rowText(row, "review_owner") !== identity.userId ||
          rowText(row, "review_key") !== request.idempotencyKey ||
          rowText(row, "review_fingerprint") !== fingerprint
        )
          conflict();
        return evaluationRecord(row);
      }
      if (state !== "draft") conflict();
      const captured = storedEvaluationInput(row);
      if (captured.content === null) conflict();
      const draft = validateEvaluationDraft(
        request.draft,
        captured.mode,
        captured.content.teaching.didacticSkills,
      );
      const notice = publishNoticeInTransaction(this.database, {
        noticeId,
        teacherId: identity.userId,
        teacherDisplayName: identity.displayName,
        runId: request.runId,
        source: "approved-evaluation",
        text: draft.studentFeedback,
        createdAt: now,
        idempotencyKey: `evaluation:${evaluationDigest(request.evaluationId).slice(7)}`,
        fingerprint: evaluationDigest(JSON.stringify([request.evaluationId, draft])),
      });
      this.database.execute(
        `UPDATE marea_evaluations SET state = 'approved', draft_json = ?2, notice_id = ?3,
          approved_at = ?4, updated_at = ?4, review_owner = ?5, review_key = ?6, review_fingerprint = ?7
          WHERE id = ?1`,
        [
          request.evaluationId,
          JSON.stringify(draft),
          notice.noticeId,
          now,
          identity.userId,
          request.idempotencyKey,
          fingerprint,
        ],
      );
      return evaluationRecord(this.requiredRow(request.evaluationId));
    });
  }

  private insert(input: {
    readonly captured: EvaluationInput;
    readonly evaluationId: string;
    readonly now: string;
    readonly owner: string;
    readonly key: string;
    readonly fingerprint: string;
    readonly generation: number;
  }): TeacherEvaluation {
    const serialized = JSON.stringify(input.captured);
    const failure =
      input.captured.content === null
        ? "input-too-large"
        : input.captured.content.providerRoute.budget === undefined
          ? "unconfigured"
          : null;
    this.database.execute(
      `INSERT INTO marea_evaluations
        (id, run_id, generation, action_owner, action_key, request_fingerprint, input_json, input_digest, state, created_at, updated_at, failure_code)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)`,
      [
        input.evaluationId,
        input.captured.runId,
        input.generation,
        input.owner,
        input.key,
        input.fingerprint,
        serialized,
        evaluationDigest(serialized),
        failure === null ? "queued" : "failed",
        input.now,
        failure,
      ],
    );
    return evaluationRecord(this.requiredRow(input.evaluationId));
  }

  private latestRow(runId: string): SqliteRow | undefined {
    return this.database.readOne(
      "SELECT * FROM marea_evaluations WHERE run_id = ?1 ORDER BY generation DESC LIMIT 1",
      [runId],
    );
  }

  private requiredRow(evaluationId: string): SqliteRow {
    const row = this.database.readOne("SELECT * FROM marea_evaluations WHERE id = ?1", [
      evaluationId,
    ]);
    if (row === undefined) conflict();
    return row;
  }

  private requireAccess(identity: AuthenticatedIdentity, runId: string): void {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    if (
      this.database.readOne(
        `SELECT runs.id FROM marea_runs runs JOIN marea_teacher_classes access ON access.class_id = runs.class_id
        WHERE runs.id = ?1 AND access.teacher_id = ?2
          AND ${activeGovernanceMembership("?2", "runs.class_id", "'teacher'")}`,
        [runId, identity.userId],
      ) === undefined
    )
      throw new TeacherDomainError("run.unavailable");
  }
}
