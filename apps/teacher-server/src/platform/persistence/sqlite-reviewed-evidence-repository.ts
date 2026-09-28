import {
  ReviewedCriterionKeySchema,
  type ReviewedEvidenceQuery,
  type ReviewedCriterionKey,
  type ReviewedEvidenceResponse,
} from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { ReviewedEvidenceRepository } from "../../reviewed-evidence/service.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { SqliteTeachingConfigurationRepository } from "./sqlite-teaching-configuration-repository.js";
import { rowInteger, rowText } from "./row-parser.boundary.js";
import { evaluationRecord, storedEvaluationInput } from "./sqlite-evaluation-record.js";

const approved = `FROM marea_evaluations e JOIN marea_runs r ON r.id = e.run_id
  WHERE e.state = 'approved' AND r.class_id = ?1`;
const criteria = `WITH criteria AS (
  SELECT e.id AS evaluation_id, json_extract(c.value, '$.skillId') AS skill_id,
    json_extract(s.value, '$.digest') AS digest, json_extract(c.value, '$.code') AS code
  FROM marea_evaluations e JOIN marea_runs r ON r.id = e.run_id,
    json_each(e.draft_json, '$.criteria') c,
    json_each(e.input_json, '$.didacticSkills') s
  WHERE e.state = 'approved' AND r.class_id = ?1 AND r.student_id = ?2
    AND json_extract(s.value, '$.id') = json_extract(c.value, '$.skillId'))`;

/** Bounded SQL pages over existing approved records; no materialized learning score. */
export class SqliteReviewedEvidenceRepository implements ReviewedEvidenceRepository {
  constructor(private readonly database: SqliteApplicationDatabase) {}
  transaction<T>(read: () => T): T {
    return this.database.transaction(read);
  }
  requireTeacherClass(teacherId: string, classId: string): void {
    new SqliteTeachingConfigurationRepository(this.database).requireTeacherClass(
      teacherId,
      classId,
    );
  }
  read(query: ReviewedEvidenceQuery): ReviewedEvidenceResponse {
    if (query.kind === "students") return this.students(query);
    if (query.kind === "criteria") return this.criteria(query);
    return this.history(query);
  }
  private students(
    query: Extract<ReviewedEvidenceQuery, { kind: "students" }>,
  ): ReviewedEvidenceResponse {
    const rows = this.database.readAll(
      `SELECT DISTINCT r.student_id, u.display_name
      FROM marea_evaluations e JOIN marea_runs r ON r.id = e.run_id
      JOIN marea_users u ON u.id = r.student_id
      WHERE e.state = 'approved' AND r.class_id = ?1 AND (?2 IS NULL OR r.student_id > ?2)
      ORDER BY r.student_id COLLATE BINARY LIMIT ?3`,
      [query.classId, query.after ?? null, query.limit + 1],
    );
    const entries = rows.slice(0, query.limit).map((row) => ({
      studentId: rowText(row, "student_id"),
      displayName: rowText(row, "display_name"),
    }));
    return {
      kind: "students",
      query,
      entries,
      next:
        rows.length > query.limit
          ? entries.reduce<string | null>((_previous, item) => item.studentId, null)
          : null,
    };
  }
  private criteria(
    query: Extract<ReviewedEvidenceQuery, { kind: "criteria" }>,
  ): ReviewedEvidenceResponse {
    const rows = this.database.readAll(
      `${criteria}
      SELECT skill_id, digest, code, MIN(evaluation_id) AS evaluation_id FROM criteria
      WHERE (?3 IS NULL OR (skill_id, digest, code) > (?3, ?4, ?5))
      GROUP BY skill_id, digest, code ORDER BY skill_id, digest, code LIMIT ?6`,
      [
        query.classId,
        query.studentId,
        query.after?.skillId ?? null,
        query.after?.digest ?? null,
        query.after?.code ?? null,
        query.limit + 1,
      ],
    );
    const entries = rows.slice(0, query.limit).map((row) => {
      const key = ReviewedCriterionKeySchema.parse({
        skillId: rowText(row, "skill_id"),
        digest: rowText(row, "digest"),
        code: rowText(row, "code"),
      });
      const source = this.record(query.classId, query.studentId, rowText(row, "evaluation_id"));
      const input = storedEvaluationInput(source);
      const skill = input.content?.teaching.didacticSkills.find(
        (item) => item.id === key.skillId && item.digest === key.digest,
      );
      const criterion = skill?.criteria.find((item) => item.code === key.code);
      if (criterion === undefined) throw new TeacherDomainError("request.conflict");
      return { ...key, statement: criterion.statement };
    });
    return {
      kind: "criteria",
      query,
      entries,
      next:
        rows.length > query.limit
          ? entries.reduce<ReviewedCriterionKey | null>(
              (_previous, item) => ({
                skillId: item.skillId,
                digest: item.digest,
                code: item.code,
              }),
              null,
            )
          : null,
    };
  }
  private history(
    query: Extract<ReviewedEvidenceQuery, { kind: "history" }>,
  ): ReviewedEvidenceResponse {
    const rows = this.database.readAll(
      `${criteria}
      SELECT e.*, EXISTS(SELECT 1 FROM marea_evaluations later
        WHERE later.run_id = e.run_id AND later.state = 'approved' AND later.generation > e.generation) AS has_later
      FROM marea_evaluations e JOIN criteria c ON c.evaluation_id = e.id
      WHERE c.skill_id = ?3 AND c.digest = ?4 AND c.code = ?5
        AND (?6 IS NULL OR (julianday(e.approved_at), e.id) < (julianday(?6), ?7))
      ORDER BY julianday(e.approved_at) DESC, e.id DESC LIMIT ?8`,
      [
        query.classId,
        query.studentId,
        query.criterion.skillId,
        query.criterion.digest,
        query.criterion.code,
        query.after?.approvedAt ?? null,
        query.after?.evaluationId ?? null,
        query.limit + 1,
      ],
    );
    const entries = rows.slice(0, query.limit).map((row) => {
      const record = evaluationRecord(row);
      if (record.state !== "approved") throw new TeacherDomainError("request.conflict");
      const assessment = record.draft.criteria.find(
        (item) => item.skillId === query.criterion.skillId && item.code === query.criterion.code,
      );
      if (assessment === undefined) throw new TeacherDomainError("request.conflict");
      return {
        ...assessment,
        evaluationId: record.evaluationId,
        runId: record.runId,
        generation: record.generation,
        approvedAt: record.approvedAt,
        hasLaterApproval: rowInteger(row, "has_later") === 1,
      };
    });
    return {
      kind: "history",
      query,
      entries,
      next:
        rows.length > query.limit
          ? entries.reduce<{
              approvedAt: string;
              evaluationId: (typeof entries)[number]["evaluationId"];
            } | null>(
              (_previous, item) => ({
                approvedAt: item.approvedAt,
                evaluationId: item.evaluationId,
              }),
              null,
            )
          : null,
    };
  }
  private record(classId: string, studentId: string, evaluationId: string) {
    const row = this.database.readOne(
      `SELECT e.* ${approved} AND r.student_id = ?2 AND e.id = ?3`,
      [classId, studentId, evaluationId],
    );
    if (row === undefined) throw new TeacherDomainError("request.conflict");
    evaluationRecord(row);
    return row;
  }
}
