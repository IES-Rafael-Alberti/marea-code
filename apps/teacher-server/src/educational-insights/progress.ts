import { createHash, randomUUID } from "node:crypto";
import {
  StudentRunSnapshotSchema,
  type EvaluationDraft,
  type InsightsSettings,
  InsightsSettingsSchema,
  LearningTargetSchema,
  type LearningTarget,
} from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { RunSnapshotCapture } from "../sessions/contracts.js";
import type { EvaluationInput } from "../evaluation/evaluation-input.js";
import { SqliteTeachingConfigurationRepository } from "../platform/persistence/sqlite-teaching-configuration-repository.js";

export const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const DEFAULT_LEVELS = [
  "Completar la tarea con guía paso a paso",
  "Completar la tarea con ayuda parcial",
  "Resolver de forma autónoma y justificar las decisiones",
  "Transferir el aprendizaje a una situación nueva",
];
export class LearningProgress {
  constructor(readonly database: SqliteApplicationDatabase) {}
  require(identity: AuthenticatedIdentity, classId: string): void {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    new SqliteTeachingConfigurationRepository(this.database).requireTeacherClass(
      identity.userId,
      classId,
    );
  }
  settings(classId: string): { settings: InsightsSettings; revision: string } {
    const row = this.database.readOne("SELECT * FROM marea_learning_settings WHERE class_id = ?1", [
      classId,
    ]);
    return row === undefined
      ? { settings: { map: false, adaptive: false }, revision: "initial" }
      : {
          settings: InsightsSettingsSchema.parse(JSON.parse(String(row.value_json))),
          revision: String(row.revision),
        };
  }
  configure(
    classId: string,
    value: InsightsSettings,
    revision: string,
    authorize: () => void = () => undefined,
  ) {
    return this.database.transaction(() => {
      authorize();
      if (this.settings(classId).revision !== revision)
        throw new TeacherDomainError("request.conflict");
      this.database.execute(
        "INSERT INTO marea_learning_settings VALUES (?1, ?2, ?3) ON CONFLICT(class_id) DO UPDATE SET revision = excluded.revision, value_json = excluded.value_json",
        [classId, randomUUID(), JSON.stringify(value)],
      );
      return this.settings(classId);
    });
  }
  capture(captured: RunSnapshotCapture, identity: AuthenticatedIdentity): RunSnapshotCapture {
    const classId = identity.classId;
    if (
      classId === null ||
      captured.snapshot.agentMode !== "tutoring" ||
      !this.settings(classId).settings.adaptive ||
      captured.teaching === undefined
    )
      return captured;
    const targets: LearningTarget[] = [];
    const memories: string[] = [];
    for (const skill of captured.teaching.didacticSkills)
      for (const criterion of skill.criteria) {
        const levels = criterion.levels ?? DEFAULT_LEVELS;
        const key = digest(JSON.stringify([skill.id, criterion.code, criterion.statement, levels]));
        const definition = {
          key,
          skillId: skill.id,
          code: criterion.code,
          statement: criterion.statement,
          levels,
        };
        this.database.execute(
          "INSERT OR IGNORE INTO marea_learning_progress (class_id,student_id,criterion_key,definition_json,level,epoch,revision) VALUES (?1, ?2, ?3, ?4, 0, 0, ?5)",
          [classId, identity.userId, key, JSON.stringify(definition), randomUUID()],
        );
        const row = this.database.readOne(
          "SELECT level, epoch, memory FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
          [classId, identity.userId, key],
        );
        const achieved = Number(row?.level ?? 0);
        if (row?.memory) memories.push(`${skill.id}/${criterion.code}: ${String(row.memory)}`);
        targets.push({
          ...definition,
          levels: [...levels],
          achieved,
          target: Math.min(4, achieved + 1),
          epoch: Number(row?.epoch ?? 0),
        });
      }
    const context = targets
      .filter((item) => item.achieved < 4)
      .map(
        (item) => `${item.skillId}/${item.code}: ${item.levels[item.target - 1] ?? item.statement}`,
      )
      .join("\n");
    const content = `${captured.snapshot.prompt.content}\n\nObjetivos pedagógicos revisados para esta sesión. Adapta la ayuda a estos objetivos sin revelar notas privadas ni presentar niveles como calificaciones:\n${context}\nSíntesis pedagógica revisada:\n${memories.join("\n")}`;
    return {
      ...captured,
      snapshot: StudentRunSnapshotSchema.parse({
        ...captured.snapshot,
        prompt: { ...captured.snapshot.prompt, content, digest: digest(content) },
      }),
      teaching: { ...captured.teaching, adaptive: { targets } },
    };
  }
  apply(input: EvaluationInput, draft: EvaluationDraft, actor: string, now: string): void {
    const targets = input.content?.teaching.adaptive?.targets;
    if (input.mode !== "tutoring" || targets === undefined) return;
    const run = this.database.readOne("SELECT class_id, student_id FROM marea_runs WHERE id = ?1", [
      input.runId,
    ]);
    if (run === undefined) throw new TeacherDomainError("run.unavailable");
    for (const target of targets) {
      const assessment = draft.criteria.find(
        (item) => item.skillId === target.skillId && item.code === target.code,
      );
      if (assessment?.levelAttempted !== target.target)
        throw new TeacherDomainError("request.conflict");
      const row = this.database.readOne(
        "SELECT * FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
        [run.class_id ?? null, run.student_id ?? null, target.key],
      );
      if (
        row === undefined ||
        Number(row.epoch) !== target.epoch ||
        this.database.readOne(
          "SELECT id FROM marea_learning_history WHERE run_id = ?1 AND criterion_key = ?2",
          [input.runId, target.key],
        ) !== undefined
      )
        continue;
      const previous = Number(row.level);
      const next =
        assessment.result === "passed" && target.target === previous + 1 ? target.target : previous;
      this.database.execute(
        "INSERT INTO marea_learning_history (class_id, student_id, criterion_key, run_id, previous_level, level, reason, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        [
          run.class_id ?? null,
          run.student_id ?? null,
          target.key,
          input.runId,
          previous,
          next,
          assessment.evidence,
          actor,
          now,
        ],
      );
      this.database.execute(
        "UPDATE marea_learning_progress SET level = ?4, revision = ?5, memory = ?6, memory_run_id = ?7 WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
        [
          run.class_id ?? null,
          run.student_id ?? null,
          target.key,
          next,
          randomUUID(),
          assessment.learningNote ?? "",
          input.runId,
        ],
      );
    }
  }
  read(classId: string, studentId: string | null, after: string | null) {
    if (studentId === null)
      return {
        students: this.database
          .readAll(
            "SELECT id, display_name AS displayName FROM marea_users WHERE class_id = ?1 AND role = 'student' AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT 101",
            [classId, after],
          )
          .map((r) => ({ id: String(r.id), displayName: String(r.displayName) })),
      };
    const rows = this.database.readAll(
      "SELECT * FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 ORDER BY criterion_key",
      [classId, studentId],
    );
    return {
      revision: digest(JSON.stringify(rows.map((row) => String(row.revision)))),
      entries: rows.map((r) => ({
        ...LearningTargetSchema.omit({ achieved: true, target: true, epoch: true }).parse(
          JSON.parse(String(r.definition_json)),
        ),
        level: Number(r.level),
        epoch: Number(r.epoch),
        revision: String(r.revision),
      })),
    };
  }
  adjust(
    classId: string,
    studentId: string,
    keys: readonly string[],
    level: number,
    reason: string,
    revision: string,
    actor: string,
    now: string,
    authorize: () => void = () => undefined,
  ): void {
    this.database.transaction(() => {
      authorize();
      const current = this.read(classId, studentId, null);
      if (!("revision" in current) || current.revision !== revision)
        throw new TeacherDomainError("request.conflict");
      for (const key of new Set(keys)) {
        const row = this.database.readOne(
          "SELECT level FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
          [classId, studentId, key],
        );
        if (row === undefined) throw new TeacherDomainError("request.conflict");
        this.database.execute(
          "INSERT INTO marea_learning_history (class_id, student_id, criterion_key, previous_level, level, reason, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
          [classId, studentId, key, Number(row.level), level, reason, actor, now],
        );
        this.database.execute(
          "UPDATE marea_learning_progress SET level = ?4, epoch = epoch + 1, revision = ?5, memory = '', memory_run_id = NULL WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
          [classId, studentId, key, level, randomUUID()],
        );
      }
    });
  }
}
