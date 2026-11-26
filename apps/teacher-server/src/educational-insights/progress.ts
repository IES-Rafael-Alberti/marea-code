import { rowNullableText, rowText } from "../platform/persistence/row-parser.boundary.js";
import { studentClassMember } from "../platform/persistence/governance-access-sql.js";
import { createHash, randomUUID } from "node:crypto";
import {
  StudentRunSnapshotSchema,
  type EvaluationDraft,
  LearningTargetSchema,
  type LearningTarget,
} from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { AuthenticatedIdentity, Clock } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { RunSnapshotCapture } from "../sessions/contracts.js";
import type { EvaluationInput } from "../evaluation/evaluation-input.js";
import { SqliteTeachingConfigurationRepository } from "../platform/persistence/sqlite-teaching-configuration-repository.js";
import type { TeachingSnapshotContent } from "../teaching/configuration/configuration-schema.js";
import { appendNote, noteDate } from "./notes-text.js";
import { LearningSettings } from "./learning-settings.js";
import { readNotesNotice, recordNotesNotice } from "./notes-notice.js";
import type { CriterionNotes, SessionNotes } from "./session-notes.js";

const OVERVIEW_PAGE = 25;
interface Projection {
  readonly revision: string;
  readonly entries: (Omit<LearningTarget, "achieved" | "target" | "epoch"> & {
    readonly level: number;
    readonly epoch: number;
    readonly revision: string;
    readonly notesLength: number;
  })[];
}
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const DEFAULT_LEVELS = [
  "Completar la tarea con guía paso a paso",
  "Completar la tarea con ayuda parcial",
  "Resolver de forma autónoma y justificar las decisiones",
  "Transferir el aprendizaje a una situación nueva",
];
/** Every criterion of the session's didactic skills, keyed by its frozen definition. */
function definitions(teaching: TeachingSnapshotContent) {
  return teaching.didacticSkills.flatMap((skill) =>
    skill.criteria.map((criterion) => {
      const levels = criterion.levels ?? DEFAULT_LEVELS;
      return {
        key: digest(JSON.stringify([skill.id, criterion.code, criterion.statement, levels])),
        skillId: skill.id,
        code: criterion.code,
        statement: criterion.statement,
        levels,
      };
    }),
  );
}
export class LearningProgress extends LearningSettings {
  constructor(
    database: SqliteApplicationDatabase,
    readonly clock: Clock,
    readonly notes: SessionNotes,
  ) {
    super(database);
  }
  require(identity: AuthenticatedIdentity, classId: string): void {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    new SqliteTeachingConfigurationRepository(this.database).requireTeacherClass(
      identity.userId,
      classId,
    );
  }
  /** The class and teaching content of an adaptive tutoring capture, or undefined. */
  private adaptive(captured: RunSnapshotCapture, identity: AuthenticatedIdentity) {
    const classId = identity.classId;
    if (
      // Stryker disable next-line ConditionalExpression: a null class has no settings row, so adaptation stays off.
      classId === null ||
      captured.snapshot.agentMode !== "tutoring" ||
      !this.settings(classId).settings.adaptive ||
      captured.teaching === undefined
    )
      return undefined;
    return { classId, teaching: captured.teaching };
  }
  /** The stored notes of the given criteria, labelled as the tutor prompt shows them. */
  private notesOf(
    classId: string,
    studentId: string,
    criteria: ReturnType<typeof definitions>,
  ): CriterionNotes[] {
    return criteria.flatMap((criterion) => {
      const notes = this.database.readOne(
        "SELECT memory FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
        [classId, studentId, criterion.key],
      )?.memory;
      return notes
        ? [{ label: `${criterion.skillId}/${criterion.code}`, notes: String(notes) }]
        : [];
    });
  }
  /**
   * Runs before a new run opens, outside its transaction: when the session's notes would not
   * fit the tutor prompt it asks the model for a summary that `capture` can then use.
   */
  async prepare(captured: RunSnapshotCapture, identity: AuthenticatedIdentity): Promise<void> {
    const adaptive = this.adaptive(captured, identity);
    if (adaptive === undefined) return;
    await this.notes.prepare(
      captured.providerRoute,
      `${adaptive.classId}\n${identity.userId}`,
      `notes-session:${identity.userId}:${this.clock.now().slice(0, 10)}`,
      this.notesOf(adaptive.classId, identity.userId, definitions(adaptive.teaching)),
    );
  }
  capture(captured: RunSnapshotCapture, identity: AuthenticatedIdentity): RunSnapshotCapture {
    const adaptive = this.adaptive(captured, identity);
    if (adaptive === undefined) return captured;
    const { classId, teaching } = adaptive;
    const criteria = definitions(teaching);
    const targets: LearningTarget[] = [];
    for (const definition of criteria) {
      this.database.execute(
        "INSERT OR IGNORE INTO marea_learning_progress (class_id,student_id,criterion_key,definition_json,level,epoch,revision) VALUES (?1, ?2, ?3, ?4, 0, 0, ?5)",
        [classId, identity.userId, definition.key, JSON.stringify(definition), randomUUID()],
      );
      const row = this.database.readOne(
        "SELECT level, epoch FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
        [classId, identity.userId, definition.key],
      );
      const achieved = Number(row?.level ?? 0);
      targets.push({
        ...definition,
        levels: [...definition.levels],
        achieved,
        target: Math.min(4, achieved + 1),
        epoch: Number(row?.epoch ?? 0),
      });
    }
    const notes = this.notes.fit(
      captured.providerRoute,
      `${classId}\n${identity.userId}`,
      this.notesOf(classId, identity.userId, criteria),
    );
    if (notes.shortened !== null)
      recordNotesNotice(this.database, identity.userId, {
        classId,
        sessionDate: noteDate(this.clock.now()),
        shortened: notes.shortened,
      });
    const context = targets
      .filter((item) => item.achieved < 4)
      .map(
        (item) =>
          // Stryker disable next-line StringLiteral: the slice holds a single level, so no separator appears.
          `${item.skillId}/${item.code}: ${item.levels.slice(item.target - 1, item.target).join("")}`,
      )
      .join("\n");
    const content = `${captured.snapshot.prompt.content}\n\nObjetivos pedagógicos revisados para esta sesión. Adapta la ayuda a estos objetivos sin revelar notas privadas ni presentar niveles como calificaciones:\n${context}\nNotas de aprendizaje revisadas:\n${notes.text}`;
    return {
      ...captured,
      snapshot: StudentRunSnapshotSchema.parse({
        ...captured.snapshot,
        prompt: { ...captured.snapshot.prompt, content, digest: digest(content) },
      }),
      teaching: { ...teaching, adaptive: { targets } },
    };
  }
  apply(input: EvaluationInput, draft: EvaluationDraft, actor: string, now: string): void {
    const targets = input.content?.teaching.adaptive?.targets;
    if (input.mode !== "tutoring" || targets === undefined) return;
    const run = this.database.readOne(
      "SELECT class_id, student_id, opened_at FROM marea_runs WHERE id = ?1",
      [input.runId],
    );
    if (run === undefined) throw new TeacherDomainError("run.unavailable");
    const classId = rowText(run, "class_id");
    const studentId = rowText(run, "student_id");
    for (const target of targets) {
      const assessment = draft.criteria.find(
        (item) => item.skillId === target.skillId && item.code === target.code,
      );
      if (assessment?.levelAttempted !== target.target)
        throw new TeacherDomainError("request.conflict");
      const row = this.database.readOne(
        "SELECT * FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
        [classId, studentId, target.key],
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
          classId,
          studentId,
          target.key,
          input.runId,
          previous,
          next,
          assessment.evidence,
          actor,
          now,
        ],
      );
      // One dated line per reviewed note; a note without evidence or text adds nothing.
      const note = (assessment.learningNote ?? "").replaceAll(/\s+/gu, " ").trim();
      const adds = note !== "" && assessment.result !== "no-evidence";
      this.database.execute(
        "UPDATE marea_learning_progress SET level = ?4, revision = ?5, memory = ?6, memory_run_id = ?7 WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
        [
          classId,
          studentId,
          target.key,
          next,
          randomUUID(),
          adds
            ? appendNote(String(row.memory), `${noteDate(rowText(run, "opened_at"))}: ${note}`)
            : String(row.memory),
          adds ? input.runId : rowNullableText(row, "memory_run_id"),
        ],
      );
    }
  }
  read(classId: string, studentId: string): Projection {
    return this.project(
      this.database.readAll(
        "SELECT * FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 ORDER BY criterion_key",
        [classId, studentId],
      ),
    );
  }
  /** One page of students with their criteria, read in two bounded queries. */
  overview(classId: string, after: string | null) {
    const listed = this.database.readAll(
      `SELECT id, display_name AS displayName FROM marea_users
        WHERE role = 'student' AND ${studentClassMember("marea_users.id", "?1")}
          AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3`,
      [classId, after, OVERVIEW_PAGE + 1],
    );
    const students = listed
      .slice(0, OVERVIEW_PAGE)
      .map((r) => ({ id: String(r.id), displayName: String(r.displayName) }));
    // Only a longer listing has a next page, which starts after this page's last student.
    const last = listed.length > OVERVIEW_PAGE ? students.at(-1) : undefined;
    // SQLite accepts an empty IN list, so an empty page needs no special case.
    const rows = this.database.readAll(
      `SELECT * FROM marea_learning_progress WHERE class_id = ?1 AND student_id IN (${students
        .map((_, index) => `?${String(index + 2)}`)
        .join(",")}) ORDER BY student_id, criterion_key`,
      [classId, ...students.map((student) => student.id)],
    );
    return {
      students: students.map((student) => ({
        ...student,
        ...this.project(rows.filter((row) => String(row.student_id) === student.id)),
        notesNotice: readNotesNotice(this.database, classId, student.id),
      })),
      next: last?.id ?? null,
    };
  }
  private project(rows: ReturnType<SqliteApplicationDatabase["readAll"]>): Projection {
    return {
      revision: digest(JSON.stringify(rows.map((row) => String(row.revision)))),
      entries: rows.map((r) => ({
        ...LearningTargetSchema.omit({ achieved: true, target: true, epoch: true }).parse(
          JSON.parse(String(r.definition_json)),
        ),
        level: Number(r.level),
        epoch: Number(r.epoch),
        revision: String(r.revision),
        notesLength: String(r.memory).length,
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
      if (this.read(classId, studentId).revision !== revision)
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
          "UPDATE marea_learning_progress SET level = ?4, epoch = epoch + 1, revision = ?5 WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
          [classId, studentId, key, level, randomUUID()],
        );
      }
    });
  }
}
