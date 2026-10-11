import { onTestFinished } from "vitest";
import { createSkillAssignmentMigrationCatalog } from "@marea/sqlite-storage/catalogs";
import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import { teachingConfiguration, teachingSkill } from "../../../test-support/teaching-fixture.js";
import {
  MemorySkillSource,
  student,
  teacher,
} from "../../teaching/configuration/dashboard-module.fixture.js";
import { SqliteTeachingConfigurationRepository } from "./sqlite-teaching-configuration-repository.js";
import { SqliteSkillAssignments } from "./sqlite-skill-assignments.js";
import { SkillWorkspaceService } from "../../teaching/skills/workspace-service.boundary.js";
import { SkillWorkspaceRequestSchema, type SkillWorkspaceRequest } from "@marea/protocol";

export function skillAssignmentFixture() {
  const database = new NodeSqliteTestDatabase();
  onTestFinished(() => {
    database.close();
  });
  database.executeScript("PRAGMA foreign_keys = ON");
  for (const migration of createSkillAssignmentMigrationCatalog()) {
    for (const statement of migration.statements) database.executeScript(statement);
  }
  database.execute(
    "INSERT INTO marea_classes VALUES ('class:one', 'one', 'First'), ('class:two', 'two', 'Second')",
  );
  database.execute(`INSERT INTO marea_users VALUES
    ('t1','teacher','hash','teacher','Teacher',NULL),
    ('t2','other','hash','teacher','Other',NULL),
    ('s1','ana','hash','student','Ana','class:one'),
    ('s2','pablo','hash','student','Pablo','class:one'),
    ('s3','other-student','hash','student','Other Student','class:two')`);
  database.execute(
    "INSERT INTO marea_teacher_classes VALUES ('t1','class:one'), ('t2','class:two')",
  );
  const configurations = new SqliteTeachingConfigurationRepository(database);
  const clock = { now: () => "2026-10-11T10:00:00.000Z" };
  configurations.saveRevision({
    classId: "class:one",
    teacherId: "t1",
    createdAt: clock.now(),
    expectedVersion: null,
    configuration: teachingConfiguration(),
  });
  let sequence = 1;
  const ids = { createId: () => `revision:test-${String(++sequence)}` };
  const assignments = new SqliteSkillAssignments(
    database,
    configurations.requireTeacherClass.bind(configurations),
    ids,
    clock,
  );
  const bundles = [teachingSkill("didactic"), teachingSkill("evaluation")];
  let source = new MemorySkillSource(bundles);
  const service = new SkillWorkspaceService(assignments, () => source);
  const request = (input: object): SkillWorkspaceRequest =>
    SkillWorkspaceRequestSchema.parse({
      protocolVersion: "0.1",
      requestId: "request:skills",
      classId: "class:one",
      ...input,
    });
  const assign = (
    selection: object[] | null,
    students = [{ studentId: "s1", expectedVersion: null as string | null }],
  ) =>
    service.execute(
      teacher,
      request({
        kind: "assign",
        students,
        expectedClassVersion: configurations.loadForTeacher("t1", "class:one")?.content
          .configurationVersion,
        selection,
      }),
    );
  return {
    database,
    configurations,
    assignments,
    service,
    bundles,
    request,
    assign,
    teacher,
    student,
    setSource: (next: MemorySkillSource) => {
      source = next;
    },
  };
}
