import { expect, it, vi } from "vitest";
import { SkillWorkspaceService } from "../../teaching/skills/workspace-service.boundary.js";
import { SkillAuthoringStore } from "../../teaching/authoring/skill-authoring-store.boundary.js";
import {
  newRoot,
  skill,
  saveRequest,
} from "../../teaching/authoring/authoring-test-support.fixture.js";
import { skillAssignmentFixture } from "./skill-assignments.fixture.js";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import { replaceTeachingSkills } from "../../teaching/configuration/replace-skills.js";
import { MemorySkillSource } from "../../teaching/configuration/dashboard-module.fixture.js";

async function fixture(kind: "didactic" | "evaluation" = "didactic") {
  const f = skillAssignmentFixture();
  const store = new SkillAuthoringStore(await newRoot(), { source: "teacher", id: "t1" });
  const bundle = await store.create(saveRequest(kind, "owned", skill("owned")));
  const previous = teachingConfiguration();
  const configuration = replaceTeachingSkills(
    { ...previous, content: { ...previous.content, automaticEvaluation: kind === "evaluation" } },
    kind === "didactic" ? [bundle] : previous.content.didacticSkills,
    kind === "evaluation" ? [bundle] : previous.content.evaluationSkills,
    "revision:owned",
  );
  f.configurations.saveRevision({
    classId: "class:one",
    teacherId: "t1",
    createdAt: "now",
    expectedVersion: "revision:1",
    configuration,
  });
  f.setSource(new MemorySkillSource([bundle]));
  if (kind === "didactic") await f.assign([{ id: bundle.id, digest: bundle.digest }]);
  const generator = { generate: vi.fn(() => Promise.resolve("generated")) };
  const service = new SkillWorkspaceService(
    f.assignments,
    () => ({ list: store.list.bind(store), load: store.read.bind(store) }),
    { generator, writerForTeacher: () => store },
  );
  const request = () =>
    f.request({
      kind: "delete",
      skillId: bundle.id,
      digest: bundle.digest,
      expectedUsage: f.assignments.usage("t1", bundle.id).version,
    });
  return { ...f, service, store, bundle, generator, request, requestInput: f.request };
}
it.each(["didactic", "evaluation"] as const)(
  "deletes owned %s skills, withdraws current assignments and preserves historical content",
  async (kind) => {
    const f = await fixture(kind);
    const history = f.database.readAll("SELECT * FROM marea_class_teaching_revisions ORDER BY id");
    const other = await f.store.create(saveRequest("didactic", "other", skill("other")));
    expect(await f.service.execute(f.teacher, f.request())).toMatchObject({ kind: "delete" });
    expect(await f.store.read(f.bundle.id)).toBeNull();
    expect(await f.store.read(other.id)).toEqual(other);
    expect(f.assignments.usage("t1", f.bundle.id).uses).toEqual([]);
    const current = f.configurations.loadForTeacher("t1", "class:one");
    expect(current?.selection[kind]).toEqual([]);
    expect(current?.content.automaticEvaluation).toBe(false);
    if (kind === "didactic")
      expect(f.assignments.students("class:one", null).students[0]?.selection).toEqual([]);
    for (const revision of history)
      expect(
        f.database.readOne("SELECT * FROM marea_class_teaching_revisions WHERE id = ?1", [
          String(revision.id),
        ]),
      ).toEqual(revision);
    await f.store.recover();
    expect(await f.store.read(f.bundle.id)).toBeNull();
  },
);
it("rejects stale usage, stale files, foreign ownership and changed authorization without deleting the source", async () => {
  const f = await fixture();
  const request = f.request();
  for (const patch of [
    { expectedUsage: `sha256:${"0".repeat(64)}` },
    { digest: `sha256:${"0".repeat(64)}` },
    { skillId: "teacher/t2/testing" },
    { skillId: "marea/testing" },
  ]) {
    await expect(
      f.service.execute(f.teacher, { ...request, ...patch } as typeof request),
    ).rejects.toThrow();
    expect(await f.store.read(f.bundle.id)).toEqual(f.bundle);
  }
  await expect(f.service.execute(f.student, request)).rejects.toThrow();
  f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
  await expect(f.service.execute(f.teacher, request)).rejects.toThrow();
  expect(await f.store.read(f.bundle.id)).toEqual(f.bundle);
});
it("does not leave hidden assignments in a class the owner cannot administer", async () => {
  const f = await fixture();
  const config = replaceTeachingSkills(teachingConfiguration(), [f.bundle], [], "revision:other");
  f.configurations.saveRevision({
    classId: "class:two",
    teacherId: "t2",
    createdAt: "now",
    expectedVersion: null,
    configuration: config,
  });
  await expect(f.service.execute(f.teacher, f.request())).rejects.toMatchObject({
    code: "dashboard.forbidden",
  });
  expect(await f.store.read(f.bundle.id)).toEqual(f.bundle);
  expect(f.assignments.usage("t1", f.bundle.id).uses).toHaveLength(1);
});
it("requires optional tools, reauthorizes generated text after the provider call and forwards cancellation", async () => {
  const f = await fixture();
  const request = f.request();
  await expect(
    new SkillWorkspaceService(f.assignments, () => ({
      list: f.store.list.bind(f.store),
      load: f.store.read.bind(f.store),
    })).execute(f.teacher, request),
  ).rejects.toThrow("unavailable");
  const parsed = f.requestInput({
    kind: "generate",
    slug: "testing",
    skillKind: "didactic",
    instructions: "Testing",
    locale: "es",
  });
  await expect(
    new SkillWorkspaceService(f.assignments, () => ({
      list: f.store.list.bind(f.store),
      load: f.store.read.bind(f.store),
    })).execute(f.teacher, parsed),
  ).rejects.toThrow("unavailable");
  const signal = new AbortController().signal;
  expect(await f.service.execute(f.teacher, parsed, signal)).toMatchObject({
    kind: "generate",
    content: "generated",
  });
  expect(f.generator.generate).toHaveBeenCalledWith("t1", parsed, signal);
  f.generator.generate.mockImplementationOnce(() => {
    f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
    return Promise.resolve("private");
  });
  await expect(f.service.execute(f.teacher, parsed, signal)).rejects.toMatchObject({
    code: "dashboard.forbidden",
  });
});
it("withdraws a skill used only by an individual while retaining unrelated class settings and selections", async () => {
  const f = await fixture();
  const current = f.configurations.loadForTeacher("t1", "class:one");
  if (!current) throw new Error("configuration");
  const base = teachingConfiguration();
  f.configurations.saveRevision({
    classId: "class:one",
    teacherId: "t1",
    createdAt: "now",
    expectedVersion: current.content.configurationVersion,
    configuration: replaceTeachingSkills(
      base,
      base.content.didacticSkills,
      base.content.evaluationSkills,
      "revision:class-reset",
    ),
  });
  const before = f.configurations.loadForTeacher("t1", "class:one");
  expect(f.assignments.usage("t1", f.bundle.id).uses).toMatchObject([
    { classroom: false, students: 1 },
  ]);
  await f.service.execute(f.teacher, f.request());
  expect(f.configurations.loadForTeacher("t1", "class:one")).toEqual(before);
  expect(f.assignments.students("class:one", null).students[0]?.selection).toEqual([]);
});
