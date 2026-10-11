import { createHash } from "node:crypto";
import * as z from "zod";
import {
  SkillBundleSchema,
  type SkillWorkspaceRequest,
  type SkillWorkspaceStudent,
} from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { AuthenticatedIdentity, Clock, IdGenerator } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import {
  StoredTeachingConfigurationSchema,
  type StoredTeachingConfiguration,
} from "../../teaching/configuration/configuration-schema.js";
import { replaceTeachingSkills } from "../../teaching/configuration/replace-skills.js";
import { activeGovernanceMembership, activeStudentClass } from "./governance-access-sql.js";
import { rowJson, rowText } from "./row-parser.boundary.js";
import { commitTeachingRevision } from "./teaching-revision-commit.js";

const didacticBundles = z
  .array(SkillBundleSchema.refine((skill) => skill.kind === "didactic"))
  .max(64);
type Bundle = z.infer<typeof SkillBundleSchema>;
interface ClassUse {
  readonly classId: string;
  readonly displayName: string;
  readonly configuration: StoredTeachingConfiguration;
  readonly assignments: readonly {
    studentId: string;
    revision: string;
    skills: readonly Bundle[];
  }[];
}
const references = (skills: readonly Bundle[]) => skills.map(({ id, digest }) => ({ id, digest }));

/** Persisted overrides are scoped to one enrolled student and one teacher-authorized class. */
export class SqliteSkillAssignments {
  constructor(
    readonly database: SqliteApplicationDatabase,
    readonly requireClass: (teacherId: string, classId: string) => void,
    readonly ids: IdGenerator,
    readonly clock: Clock,
  ) {}

  require(identity: AuthenticatedIdentity, classId: string): void {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    this.requireClass(identity.userId, classId);
  }

  students(classId: string, after: string | null) {
    const rows = this.database.readAll(
      `SELECT users.id, users.display_name,
      assignment.revision, assignment.skills_json FROM marea_users users
      LEFT JOIN marea_student_skill_assignments assignment ON assignment.student_id = users.id AND assignment.class_id = ?1
      WHERE users.role = 'student' AND ${activeStudentClass("users.id", "?1")}
        AND (?2 IS NULL OR users.id > ?2) ORDER BY users.id LIMIT 101`,
      [classId, after],
    );
    const students: SkillWorkspaceStudent[] = rows.slice(0, 100).map((row) => ({
      studentId: rowText(row, "id"),
      displayName: rowText(row, "display_name"),
      version: row.revision === null ? null : rowText(row, "revision"),
      selection:
        row.skills_json === null ? null : references(rowJson(row, "skills_json", didacticBundles)),
    }));
    const cursor = students.reduce<string | null>((_, item) => item.studentId, null);
    return {
      students,
      next: rows.length > 100 ? cursor : null,
    };
  }

  assign(
    identity: AuthenticatedIdentity,
    request: Extract<SkillWorkspaceRequest, { kind: "assign" }>,
    skills: readonly Bundle[] | null,
  ): void {
    this.database.transaction(() => {
      this.require(identity, request.classId);
      const current = this.database.readOne(
        `SELECT current.revision_id, revisions.configuration_json
         FROM marea_current_class_teaching current
         JOIN marea_class_teaching_revisions revisions ON revisions.id = current.revision_id
         WHERE current.class_id = ?1`,
        [request.classId],
      );
      if (current?.revision_id !== request.expectedClassVersion)
        throw new TeacherDomainError("request.conflict");
      if (skills !== null) {
        const configuration = rowJson(
          current,
          "configuration_json",
          StoredTeachingConfigurationSchema,
        );
        replaceTeachingSkills(
          configuration,
          skills,
          configuration.content.evaluationSkills,
          request.expectedClassVersion,
        );
      }
      // Check every target before any write; a bulk action is all-or-nothing.
      for (const target of request.students) {
        const student = this.database.readOne(
          `SELECT users.id FROM marea_users users WHERE users.id = ?1 AND users.role = 'student'
          AND ${activeStudentClass("users.id", "?2")}`,
          [target.studentId, request.classId],
        );
        if (student === undefined) throw new TeacherDomainError("dashboard.forbidden");
        const row = this.database.readOne(
          "SELECT revision FROM marea_student_skill_assignments WHERE class_id = ?1 AND student_id = ?2",
          [request.classId, target.studentId],
        );
        if ((row?.revision ?? null) !== target.expectedVersion)
          throw new TeacherDomainError("request.conflict");
      }
      for (const target of request.students) {
        if (skills === null) {
          this.database.execute(
            "DELETE FROM marea_student_skill_assignments WHERE class_id = ?1 AND student_id = ?2",
            [request.classId, target.studentId],
          );
        } else this.write(request.classId, target.studentId, skills, identity.userId);
      }
    });
  }

  private write(
    classId: string,
    studentId: string,
    skills: readonly Bundle[],
    teacherId: string,
  ): void {
    this.database.execute(
      `INSERT INTO marea_student_skill_assignments
      (class_id, student_id, revision, skills_json, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(class_id, student_id) DO UPDATE SET revision = excluded.revision,
        skills_json = excluded.skills_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [
        classId,
        studentId,
        this.ids.createId("revision"),
        JSON.stringify(skills),
        teacherId,
        this.clock.now(),
      ],
    );
  }

  private uses(teacherId: string, skillId: string): ClassUse[] {
    const rows = this.database.readAll(
      `SELECT classes.id, classes.display_name, revisions.configuration_json
      FROM marea_classes classes JOIN marea_teacher_classes membership ON membership.class_id = classes.id
      JOIN marea_current_class_teaching current ON current.class_id = classes.id
      JOIN marea_class_teaching_revisions revisions ON revisions.id = current.revision_id
      WHERE membership.teacher_id = ?1 AND ${activeGovernanceMembership("membership.teacher_id", "classes.id", "'teacher'")}
      ORDER BY classes.id`,
      [teacherId],
    );
    return rows
      .map((row) => {
        const classId = rowText(row, "id");
        const assignments = this.database
          .readAll(
            "SELECT student_id, revision, skills_json FROM marea_student_skill_assignments WHERE class_id = ?1 ORDER BY student_id",
            [classId],
          )
          .map((item) => ({
            studentId: rowText(item, "student_id"),
            revision: rowText(item, "revision"),
            skills: rowJson(item, "skills_json", didacticBundles),
          }))
          .filter((item) => item.skills.some((skill) => skill.id === skillId));
        return {
          classId,
          displayName: rowText(row, "display_name"),
          configuration: rowJson(row, "configuration_json", StoredTeachingConfigurationSchema),
          assignments,
        };
      })
      .filter((item) => this.classUses(item, skillId) || item.assignments.length > 0);
  }

  private classUses(item: ClassUse, skillId: string): boolean {
    return [
      ...item.configuration.selection.didactic,
      ...item.configuration.selection.evaluation,
    ].some((skill) => skill.id === skillId);
  }

  private version(uses: readonly ClassUse[]): string {
    return `sha256:${createHash("sha256")
      .update(
        JSON.stringify(
          uses.map((item) => ({
            classId: item.classId,
            version: item.configuration.content.configurationVersion,
            assignments: item.assignments.map(({ studentId, revision }) => ({
              studentId,
              revision,
            })),
          })),
        ),
      )
      .digest("hex")}`;
  }

  usage(teacherId: string, skillId: string) {
    const uses = this.uses(teacherId, skillId);
    return {
      version: this.version(uses),
      uses: uses.map((item) => ({
        classId: item.classId,
        displayName: item.displayName,
        classroom: this.classUses(item, skillId),
        students: item.assignments.length,
      })),
    };
  }

  apply(
    identity: AuthenticatedIdentity,
    classId: string,
    bundle: Bundle,
    expectedUsage: string,
  ): void {
    this.database.transaction(() => {
      this.require(identity, classId);
      const uses = this.uses(identity.userId, bundle.id);
      if (this.version(uses) !== expectedUsage) throw new TeacherDomainError("request.conflict");
      const replace = <T extends { readonly id: string }>(items: readonly T[], next: T) =>
        items.map((item) => (item.id === next.id ? next : item));
      for (const item of uses) {
        this.requireClass(identity.userId, item.classId);
        if (this.classUses(item, bundle.id)) {
          const c = item.configuration;
          const configuration = replaceTeachingSkills(
            c,
            replace(c.content.didacticSkills, bundle),
            replace(c.content.evaluationSkills, bundle),
            this.ids.createId("revision"),
          );
          commitTeachingRevision(this.database, {
            classId: item.classId,
            author: { kind: "teacher", userId: identity.userId },
            expectedVersion: c.content.configurationVersion,
            createdAt: this.clock.now(),
            configuration: StoredTeachingConfigurationSchema.parse({
              ...configuration,
              selection: {
                didactic: replace(c.selection.didactic, { id: bundle.id, digest: bundle.digest }),
                evaluation: replace(c.selection.evaluation, {
                  id: bundle.id,
                  digest: bundle.digest,
                }),
              },
            }),
          });
        }
        for (const assignment of item.assignments) {
          const skills = replace(assignment.skills, bundle);
          replaceTeachingSkills(
            item.configuration,
            skills,
            item.configuration.content.evaluationSkills,
            item.configuration.content.configurationVersion,
          );
          this.write(item.classId, assignment.studentId, skills, identity.userId);
        }
      }
    });
  }
}

/** Called only after the existing live student/class authorization, within run creation. */
export function individualTeachingConfiguration(
  database: SqliteApplicationDatabase,
  identity: AuthenticatedIdentity,
  configuration: StoredTeachingConfiguration,
): StoredTeachingConfiguration {
  if (
    database.readOne(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'marea_student_skill_assignments'",
    ) === undefined
  )
    return configuration;
  const assignment = database.readOne(
    "SELECT revision, skills_json FROM marea_student_skill_assignments WHERE class_id = ?1 AND student_id = ?2",
    [identity.classId, identity.userId],
  );
  if (assignment === undefined) return configuration;
  const version = `revision:${createHash("sha256")
    .update(`${configuration.content.configurationVersion}:${rowText(assignment, "revision")}`)
    .digest("hex")}`;
  return replaceTeachingSkills(
    configuration,
    rowJson(assignment, "skills_json", didacticBundles),
    configuration.content.evaluationSkills,
    version,
  );
}
