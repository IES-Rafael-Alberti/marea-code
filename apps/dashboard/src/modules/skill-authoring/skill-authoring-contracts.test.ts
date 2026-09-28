import { expect, it } from "vitest";

import type {
  SkillAuthoringClientFailure,
  SkillAuthoringModuleProperties,
  SkillAuthoringNavigationTarget,
  SkillAuthoringProblem,
  SkillAuthoringState,
} from "./skill-authoring-contracts.js";
import {
  skillAuthoringActionsFixture,
  skillAuthoringClientFixture,
  skillAuthoringDraftFixture,
  skillAuthoringPropertiesFixture,
  skillAuthoringStateFixture,
  skillCopiedFixture,
  skillCatalogFixture,
  skillClassId,
  skillMissingReadFixture,
  skillReadFixture,
  skillSavedFixture,
  skillValidatedFixture,
} from "./skill-authoring.fixture.js";

it("shares a typed authoring client over teaching navigation and authoring operations", async () => {
  const client = skillAuthoringClientFixture();
  const signal = new AbortController().signal;
  expect((await client.classes(null, signal)).classes).toEqual([
    { classId: skillClassId, displayName: "Physics" },
  ]);
  expect((await client.catalog(skillClassId, null, signal)).skills).toEqual(
    skillCatalogFixture.skills,
  );
  expect((await client.readPersonal(skillClassId, "testing", signal)).skill).toEqual(
    skillReadFixture.skill,
  );
  expect((await client.readCatalog(skillClassId, "marea/bundled", signal)).editable).toBe(false);
  expect((await client.validate(skillClassId, skillAuthoringDraftFixture, signal)).skill).toEqual(
    skillValidatedFixture.skill,
  );
  expect((await client.save(skillClassId, skillAuthoringDraftFixture, null, signal)).skill).toEqual(
    skillSavedFixture.skill,
  );
  expect(
    (
      await client.copy(
        skillClassId,
        "marea/bundled",
        skillSavedFixture.skill.digest,
        "copied",
        signal,
      )
    ).skill,
  ).toEqual(skillCopiedFixture.skill);
  expect((await client.readPersonal(skillClassId, "missing", signal)).skill).toBeNull();
  expect(skillMissingReadFixture.editable).toBe(false);
});

it("tracks staged navigation, recovery and write problems in readonly state", () => {
  const target: SkillAuthoringNavigationTarget = {
    classId: skillClassId,
    kind: "skill",
    skillId: "marea/bundled",
  };
  const failure: SkillAuthoringClientFailure = Object.assign(new Error("Save outcome unknown"), {
    code: "uncertain",
  } satisfies { code: SkillAuthoringProblem });
  const state: SkillAuthoringState = skillAuthoringStateFixture({
    dirty: true,
    pendingTarget: target,
    problem: failure.code,
    recovery: skillReadFixture,
  });
  expect(state.pendingTarget).toEqual(target);
  expect(state.recovery?.skill).toEqual(skillReadFixture.skill);
  expect(state.problem).toBe("uncertain");
});

it("binds locale, state and controller without sibling implementations", () => {
  const controller = skillAuthoringActionsFixture();
  const properties: SkillAuthoringModuleProperties = skillAuthoringPropertiesFixture(controller);
  expect(properties.locale).toBe("en");
  expect(properties.controller).toBe(controller);
  expect(properties.state.draft).toEqual(skillAuthoringDraftFixture);
  expect(properties.state.personalSlug).toBe("testing");
  expect(typeof controller.saveDraft).toBe("function");
  expect(typeof controller.startPersonalDraft).toBe("function");
});

it("represents every staged destination without replacing the current dirty draft", () => {
  const targets: readonly SkillAuthoringNavigationTarget[] = [
    { kind: "class", classId: "class:two" },
    { kind: "skill", classId: skillClassId, skillId: "marea/bundled" },
    { kind: "personal", classId: skillClassId, slug: "draft-b" },
  ];
  for (const pendingTarget of targets) {
    const state = skillAuthoringStateFixture({ dirty: true, pendingTarget });
    expect(state.pendingTarget).toEqual(pendingTarget);
    expect(state.personalSlug).toBe("testing");
    expect(state.draft).toEqual(skillAuthoringDraftFixture);
    expect(state.dirty).toBe(true);
  }
});
