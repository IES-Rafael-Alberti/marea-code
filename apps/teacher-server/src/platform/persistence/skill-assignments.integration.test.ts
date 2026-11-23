import { expect, it, vi } from "vitest";
import { skillAssignmentFixture } from "./skill-assignments.fixture.js";
import {
  MemorySkillSource,
  syntheticSkill,
} from "../../teaching/configuration/dashboard-module.fixture.js";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import { digestSkillFiles } from "../../teaching/skills/skill-digest.js";
import { replaceTeachingSkills } from "../../teaching/configuration/replace-skills.js";
import { SkillBundleSchema } from "@marea/protocol";

it("inherits by default, distinguishes an empty personal selection, and restores inheritance", async () => {
  const f = skillAssignmentFixture();
  const original = f.configurations.loadForStudent(f.student);
  expect(original?.content.didacticSkills).toHaveLength(1);
  expect(f.assignments.students("class:one", null).students).toMatchObject([
    { studentId: "s1", selection: null },
    { studentId: "s2", selection: null },
  ]);
  await f.assign([]);
  const personal = f.configurations.loadForStudent(f.student);
  expect(personal?.publicTemplate.didacticSkills).toEqual([]);
  expect(personal?.content.evaluationSkills).toEqual(original?.content.evaluationSkills);
  expect(original?.content.didacticSkills).toHaveLength(1);
  const row = f.assignments.students("class:one", null).students[0];
  expect(row?.selection).toEqual([]);
  await f.assign(null, [{ studentId: "s1", expectedVersion: row?.version ?? null }]);
  expect(f.configurations.loadForStudent(f.student)).toEqual(original);
});

it("assigns a frozen bundle to several pupils and rebuilds each future prompt while retaining the class policy", async () => {
  const f = skillAssignmentFixture();
  const remedial = syntheticSkill("didactic", "basics");
  f.setSource(new MemorySkillSource([remedial]));
  await f.assign(
    [{ id: remedial.id, digest: remedial.digest }],
    [
      { studentId: "s1", expectedVersion: null },
      { studentId: "s2", expectedVersion: null },
    ],
  );
  for (const userId of ["s1", "s2"]) {
    const capture = f.configurations.loadForStudent({ ...f.student, userId });
    expect(capture?.content.didacticSkills).toEqual([remedial]);
    expect(capture?.publicTemplate.prompt.content).toContain(remedial.id);
    expect(capture?.publicTemplate.prompt.content).not.toContain("teacher/t1/testing");
    expect(capture?.publicTemplate.teacherToolPolicy).toEqual(
      teachingConfiguration().publicTemplate.teacherToolPolicy,
    );
    expect(capture?.content.evaluationSkills).toEqual(
      teachingConfiguration().content.evaluationSkills,
    );
  }
});

it("rejects wrong-class students, unauthorized teachers, stale class/individual revisions and evaluation skills without partial writes", async () => {
  const f = skillAssignmentFixture();
  await expect(
    f.assign(
      [],
      [
        { studentId: "s1", expectedVersion: null },
        { studentId: "s3", expectedVersion: null },
      ],
    ),
  ).rejects.toMatchObject({ code: "dashboard.forbidden" });
  expect(
    f.assignments.students("class:one", null).students.every((item) => item.selection === null),
  ).toBe(true);
  await expect(
    f.service.execute({ ...f.teacher, userId: "t2" }, f.request({ kind: "students", after: null })),
  ).rejects.toThrow();
  await expect(
    f.service.execute(
      { ...f.teacher, role: "student" },
      f.request({ kind: "students", after: null }),
    ),
  ).rejects.toMatchObject({ code: "dashboard.forbidden" });
  await expect(
    f.service.execute(
      f.teacher,
      f.request({
        kind: "assign",
        students: [{ studentId: "s1", expectedVersion: null }],
        expectedClassVersion: "wrong",
        selection: [],
      }),
    ),
  ).rejects.toMatchObject({ code: "request.conflict" });
  const evaluation = f.bundles[1];
  expect(evaluation).toBeDefined();
  await expect(f.assign([{ id: evaluation?.id, digest: evaluation?.digest }])).rejects.toThrow();
  await f.assign([]);
  await expect(f.assign(null)).rejects.toMatchObject({ code: "request.conflict" });
  expect(f.assignments.students("class:one", null).students[0]?.selection).toEqual([]);
});

it("applies a saved skill to authorized class and personal selections atomically, with a usage revision check", async () => {
  const f = skillAssignmentFixture();
  const old = f.bundles[0];
  if (!old) throw new Error("fixture");
  await f.assign([{ id: old.id, digest: old.digest }]);
  const frozen = f.configurations.loadForStudent(f.student);
  const usage = f.assignments.usage("t1", old.id);
  expect(usage.uses).toEqual([
    { classId: "class:one", displayName: "First", classroom: true, students: 1 },
  ]);
  const updated = revisedBundle(old);
  f.setSource(new MemorySkillSource([updated]));
  await expect(
    f.service.execute(
      f.teacher,
      f.request({
        kind: "apply",
        skillId: old.id,
        digest: updated.digest,
        expectedUsage: `sha256:${"0".repeat(64)}`,
      }),
    ),
  ).rejects.toMatchObject({ code: "request.conflict" });
  expect(f.configurations.loadForStudent(f.student)).toEqual(frozen);
  await f.service.execute(
    f.teacher,
    f.request({
      kind: "apply",
      skillId: old.id,
      digest: updated.digest,
      expectedUsage: usage.version,
    }),
  );
  expect(f.configurations.loadForTeacher("t1", "class:one")?.content.didacticSkills).toEqual([
    updated,
  ]);
  expect(f.configurations.loadForStudent(f.student)?.content.didacticSkills).toEqual([updated]);
  expect(frozen?.content.didacticSkills).toEqual([old]);
  expect(f.assignments.usage("t1", old.id).version).not.toBe(usage.version);
});

it("keeps individual skills dormant in free mode and reapplies the latest class policies", async () => {
  const f = skillAssignmentFixture();
  const skill = f.bundles[0];
  if (!skill) throw new Error("fixture");
  await f.assign([{ id: skill.id, digest: skill.digest }]);
  const free = teachingConfiguration("free", "revision:free");
  f.configurations.saveRevision({
    classId: "class:one",
    teacherId: "t1",
    createdAt: "now",
    expectedVersion: "revision:1",
    configuration: free,
  });
  expect(f.configurations.loadForStudent(f.student)?.content.startup).toBeNull();
  expect(f.configurations.loadForStudent(f.student)?.content.didacticSkills).toEqual([]);
  expect(f.configurations.loadForStudent(f.student)?.publicTemplate.agentMode).toBe("free");
  const input = teachingConfiguration();
  expect(
    replaceTeachingSkills(input, [], input.content.evaluationSkills, "revision:next").publicTemplate
      .prompt.version,
  ).toBe("revision:next");
});

it("returns an enriched library without files or private evaluator content and paginates students", async () => {
  const f = skillAssignmentFixture();
  const page = await f.service.execute(f.teacher, f.request({ kind: "library", after: null }));
  expect(page.kind).toBe("library");
  if (page.kind !== "library") throw new Error("response");
  expect(page.skills).toHaveLength(2);
  expect(page.skills.every((item) => !("files" in item) && !("criteria" in item))).toBe(true);
  expect(page.skills.map((item) => item.title)).toEqual(["review", "testing"]);
  expect(
    await f.service.execute(f.teacher, f.request({ kind: "students", after: "s1" })),
  ).toMatchObject({ students: [{ studentId: "s2" }], next: null });
});

it("returns every roster and catalog page once and exposes human titles without private files", async () => {
  const f = skillAssignmentFixture();
  for (let index = 0; index < 101; index++)
    f.database.execute("INSERT INTO marea_users VALUES (?1,?1,'hash','student',?1,'class:one')", [
      `z${String(index).padStart(3, "0")}`,
    ]);
  const first = f.assignments.students("class:one", null);
  expect(first.students).toHaveLength(100);
  expect(first.next).toBe("z097");
  const second = f.assignments.students("class:one", first.next);
  expect(second.students.map((item) => item.studentId)).toEqual(["z098", "z099", "z100"]);
  expect(second.next).toBeNull();
  const bundles = Array.from({ length: 101 }, (_, index) =>
    syntheticSkill("didactic", `skill-${String(index).padStart(3, "0")}`),
  );
  const source = new MemorySkillSource(bundles);
  f.setSource(source);
  const page = await f.service.execute(f.teacher, f.request({ kind: "library", after: null }));
  if (page.kind !== "library") throw new Error("library");
  expect(page.skills).toHaveLength(100);
  expect(page.next).toBe("teacher/t1/skill-099");
  const next = await f.service.execute(f.teacher, f.request({ kind: "library", after: page.next }));
  if (next.kind !== "library") throw new Error("library");
  expect(next.skills.map((item) => item.id)).toEqual(["teacher/t1/skill-100"]);
  expect(next.next).toBeNull();
  const usage = await f.service.execute(
    f.teacher,
    f.request({ kind: "usage", skillId: bundles[0]?.id }),
  );
  expect(usage).toMatchObject({ kind: "usage", uses: [] });
});

it("updates individual-only usage without changing the class or another teacher's selections", async () => {
  const f = skillAssignmentFixture();
  const skill = syntheticSkill("didactic", "personal");
  f.setSource(new MemorySkillSource([skill]));
  await f.assign([{ id: skill.id, digest: skill.digest }]);
  const previous = f.configurations.loadForTeacher("t1", "class:one");
  const usage = f.assignments.usage("t1", skill.id);
  expect(usage.uses).toEqual([
    { classId: "class:one", displayName: "First", classroom: false, students: 1 },
  ]);
  await f.service.execute(
    f.teacher,
    f.request({
      kind: "apply",
      skillId: skill.id,
      digest: skill.digest,
      expectedUsage: usage.version,
    }),
  );
  expect(f.configurations.loadForTeacher("t1", "class:one")).toEqual(previous);
  expect(f.assignments.usage("t2", skill.id).uses).toEqual([]);
  await expect(
    f.service.execute(
      f.teacher,
      f.request({
        kind: "apply",
        skillId: "marea/testing",
        digest: skill.digest,
        expectedUsage: usage.version,
      }),
    ),
  ).rejects.toThrow();
  await expect(
    f.service.execute(
      f.teacher,
      f.request({
        kind: "apply",
        skillId: skill.id,
        digest: `sha256:${"0".repeat(64)}`,
        expectedUsage: usage.version,
      }),
    ),
  ).rejects.toThrow();
  await expect(
    f.service.execute(
      f.teacher,
      f.request({
        kind: "apply",
        skillId: "teacher/t1/missing",
        digest: skill.digest,
        expectedUsage: usage.version,
      }),
    ),
  ).rejects.toThrow();
});

it("rechecks teacher access after asynchronous catalog reads and never exposes a revoked class", async () => {
  const f = skillAssignmentFixture();
  const source = new MemorySkillSource(f.bundles);
  f.setSource(source);
  source.beforeList = () => {
    f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
    return Promise.resolve();
  };
  await expect(
    f.service.execute(f.teacher, f.request({ kind: "library", after: null })),
  ).rejects.toThrow();
});

it("removes personal selections when the account or class is purged", async () => {
  const f = skillAssignmentFixture();
  await f.assign(
    [],
    [
      { studentId: "s1", expectedVersion: null },
      { studentId: "s2", expectedVersion: null },
    ],
  );
  f.database.execute("DELETE FROM marea_users WHERE id = 's1'");
  expect(f.database.readAll("SELECT student_id FROM marea_student_skill_assignments")).toEqual([
    { student_id: "s2" },
  ]);
  f.database.execute("INSERT INTO marea_classes VALUES ('class:empty', 'empty', 'Empty')");
  f.database.execute("UPDATE marea_student_skill_assignments SET class_id = 'class:empty'");
  f.database.execute("DELETE FROM marea_classes WHERE id = 'class:empty'");
  expect(f.database.readAll("SELECT * FROM marea_student_skill_assignments")).toEqual([]);
});

it("rejects a combined prompt that is too large before persisting any individual assignment", async () => {
  const f = skillAssignmentFixture();
  const previous = teachingConfiguration();
  f.configurations.saveRevision({
    classId: "class:one",
    teacherId: "t1",
    createdAt: "now",
    expectedVersion: "revision:1",
    configuration: replaceTeachingSkills(
      {
        ...previous,
        classInstructions: { ...previous.classInstructions, tutoring: "a".repeat(230000) },
      },
      [],
      previous.content.evaluationSkills,
      "revision:large",
    ),
  });
  const skills = Array.from({ length: 64 }, (_, index) => ({
    ...syntheticSkill("didactic", `skill-${String(index)}`),
    description: "d".repeat(1024),
  }));
  f.setSource(new MemorySkillSource(skills));
  await expect(f.assign(skills.map(({ id, digest }) => ({ id, digest })))).rejects.toThrow();
  expect(
    f.assignments.students("class:one", null).students.every((item) => item.selection === null),
  ).toBe(true);
});

it("fails closed for corrupt individual evaluator content and missing class configuration", async () => {
  const f = skillAssignmentFixture();
  await f.assign([]);
  f.database.execute("UPDATE marea_student_skill_assignments SET skills_json=?1", [
    JSON.stringify([f.bundles[1]]),
  ]);
  expect(() => f.assignments.students("class:one", null)).toThrow();
  f.database.execute("DELETE FROM marea_current_class_teaching WHERE class_id='class:one'");
  await expect(
    f.service.execute(
      f.teacher,
      f.request({
        kind: "assign",
        expectedClassVersion: "revision:1",
        students: [{ studentId: "s1", expectedVersion: null }],
        selection: null,
      }),
    ),
  ).rejects.toMatchObject({ code: "request.conflict" });
});

it("checks write authority inside the transaction and uses revision identifiers for every updated class", () => {
  const f = skillAssignmentFixture();
  const request = f.request({
    kind: "assign",
    expectedClassVersion: "revision:1",
    students: [{ studentId: "s1", expectedVersion: null }],
    selection: [],
  });
  if (request.kind !== "assign") throw new Error("request");
  expect(() => {
    f.assignments.assign({ ...f.teacher, userId: "t2" }, request, []);
  }).toThrow();
  const skill = f.bundles[0];
  if (!skill) throw new Error("fixture");
  const usage = f.assignments.usage("t1", skill.id);
  expect(() => {
    f.assignments.apply(
      { ...f.teacher, userId: "t2" },
      "class:one",
      skill,
      f.assignments.usage("t2", skill.id).version,
    );
  }).toThrow();
  const check = vi.spyOn(f.assignments, "requireClass");
  const ids = vi.spyOn(f.assignments.ids, "createId");
  f.assignments.apply(f.teacher, "class:one", skill, usage.version);
  expect(check).toHaveBeenCalledTimes(2);
  expect(ids).toHaveBeenCalledWith("revision");
});

it("tracks only matching individual usage and detects changes to a student's saved revision", async () => {
  const f = skillAssignmentFixture();
  const one = syntheticSkill("didactic", "one"),
    two = syntheticSkill("didactic", "two");
  f.setSource(new MemorySkillSource([one, two]));
  await f.assign([one, two].map(({ id, digest }) => ({ id, digest })));
  await f.assign(
    [{ id: two.id, digest: two.digest }],
    [{ studentId: "s2", expectedVersion: null }],
  );
  const usage = f.assignments.usage("t1", one.id);
  expect(usage.uses).toMatchObject([{ students: 1 }]);
  const original = f.configurations.loadForStudent(f.student);
  const version = f.assignments.students("class:one", null).students[0]?.version;
  await f.assign(
    [one, two].map(({ id, digest }) => ({ id, digest })),
    [{ studentId: "s1", expectedVersion: version ?? null }],
  );
  expect(f.assignments.usage("t1", one.id).version).not.toBe(usage.version);
  expect(f.configurations.loadForStudent(f.student)?.content.configurationVersion).not.toBe(
    original?.content.configurationVersion,
  );
});

it("does not emit a continuation cursor for exactly one full roster or catalog page", async () => {
  const f = skillAssignmentFixture();
  for (let i = 0; i < 98; i++)
    f.database.execute("INSERT INTO marea_users VALUES (?1,?1,'hash','student',?1,'class:one')", [
      `z${String(i)}`,
    ]);
  const roster = f.assignments.students("class:one", null);
  expect(roster.students).toHaveLength(100);
  expect(roster.next).toBeNull();
  f.setSource(
    new MemorySkillSource(
      Array.from({ length: 100 }, (_, i) =>
        syntheticSkill("didactic", `skill-${String(i).padStart(3, "0")}`),
      ).reverse(),
    ),
  );
  const result = await f.service.execute(f.teacher, f.request({ kind: "library", after: null }));
  expect(result).toMatchObject({ next: null });
  if (result.kind !== "library") throw new Error("library");
  expect(result.skills.map((item) => item.name)).toEqual(
    Array.from({ length: 100 }, (_, i) => `skill-${String(i).padStart(3, "0")}`),
  );
});

it("applies private evaluator updates without putting them into the tutor's selection", () => {
  const f = skillAssignmentFixture();
  const old = f.bundles[1];
  if (!old) throw new Error("fixture");
  const updated = revisedBundle(old);
  f.setSource(new MemorySkillSource([updated]));
  f.assignments.apply(f.teacher, "class:one", updated, f.assignments.usage("t1", old.id).version);
  const stored = f.configurations.loadForTeacher("t1", "class:one");
  expect(stored?.selection.evaluation).toEqual([{ id: updated.id, digest: updated.digest }]);
  expect(stored?.content.evaluationSkills).toEqual([updated]);
  expect(stored?.content.didacticSkills).toEqual([f.bundles[0]]);
});

function revisedBundle(old: ReturnType<typeof SkillBundleSchema.parse>) {
  const files = old.files.map((file) => ({
    ...file,
    content: `${file.content}Updated.`,
    sizeBytes: file.sizeBytes + 8,
  }));
  return SkillBundleSchema.parse({ ...old, files, digest: digestSkillFiles(files) });
}
