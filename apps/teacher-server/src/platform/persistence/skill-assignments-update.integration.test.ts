import { expect, it } from "vitest";
import { skillAssignmentFixture } from "./skill-assignments.fixture.js";
import {
  MemorySkillSource,
  syntheticSkill,
} from "../../teaching/configuration/dashboard-module.fixture.js";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import { replaceTeachingSkills } from "../../teaching/configuration/replace-skills.js";

it("leaves all assignments intact when an edited skill would overflow an individual prompt", async () => {
  const f = skillAssignmentFixture();
  const skill = { ...syntheticSkill("didactic", "personal"), description: "a" };
  const previous = teachingConfiguration();
  const composed = replaceTeachingSkills(previous, [skill], [], "revision:large");
  const remaining =
    256 * 1024 - new TextEncoder().encode(composed.publicTemplate.prompt.content).length;
  const configuration = replaceTeachingSkills(
    {
      ...previous,
      classInstructions: {
        ...previous.classInstructions,
        tutoring: previous.classInstructions.tutoring + "a".repeat(remaining - 100),
      },
    },
    [],
    previous.content.evaluationSkills,
    "revision:large",
  );
  f.configurations.saveRevision({
    classId: "class:one",
    teacherId: "t1",
    createdAt: "now",
    expectedVersion: "revision:1",
    configuration,
  });
  f.setSource(new MemorySkillSource([skill]));
  await f.assign([{ id: skill.id, digest: skill.digest }]);
  const captured = f.configurations.loadForStudent(f.student);
  const usage = f.assignments.usage("t1", skill.id);
  expect(() => {
    f.assignments.apply(
      f.teacher,
      "class:one",
      { ...skill, description: "b".repeat(1024) },
      usage.version,
    );
  }).toThrow();
  expect(f.configurations.loadForStudent(f.student)).toEqual(captured);
  expect(f.assignments.usage("t1", skill.id)).toEqual(usage);
});
