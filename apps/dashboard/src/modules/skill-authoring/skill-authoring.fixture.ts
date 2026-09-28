import {
  CURRENT_PROTOCOL_VERSION,
  SkillAuthoringDraftSchema,
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringSaveResponseSchema,
  SkillAuthoringValidateResponseSchema,
  TeachingCatalogResponseSchema,
  TeachingClassesResponseSchema,
  type SkillAuthoringDraft,
} from "@marea/protocol";

import type {
  SkillAuthoringActions,
  SkillAuthoringClient,
  SkillAuthoringModuleProperties,
  SkillAuthoringState,
} from "./skill-authoring-contracts.js";

export const skillClassId = "class:one";
const skillRequestId = "request:authoring";
const skillDigest = `sha256:${"a".repeat(64)}`;
const personalSkill = {
  compatibility: null,
  criteria: [],
  description: "Testing",
  digest: skillDigest,
  files: [{ content: "Teach one idea.", path: "SKILL.md", sizeBytes: 15 }],
  id: "teacher/t1/testing",
  kind: "didactic",
  license: null,
  name: "testing",
  source: "teacher",
} as const;
const envelope = {
  classId: skillClassId,
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  requestId: skillRequestId,
};

export const skillAuthoringDraftFixture: SkillAuthoringDraft = SkillAuthoringDraftSchema.parse({
  files: [{ content: "Teach one idea.", path: "SKILL.md" }],
  kind: "didactic",
  slug: "testing",
});
export const skillReadFixture = SkillAuthoringReadResponseSchema.parse({
  ...envelope,
  editable: true,
  kind: "skill-authoring-read-result",
  skill: personalSkill,
});
export const skillMissingReadFixture = SkillAuthoringReadResponseSchema.parse({
  ...envelope,
  editable: false,
  kind: "skill-authoring-read-result",
  skill: null,
});
export const skillValidatedFixture = SkillAuthoringValidateResponseSchema.parse({
  ...envelope,
  kind: "skill-authoring-validated",
  skill: personalSkill,
});
export const skillSavedFixture = SkillAuthoringSaveResponseSchema.parse({
  ...envelope,
  kind: "skill-authoring-saved",
  skill: personalSkill,
});
export const skillCopiedFixture = SkillAuthoringCopyResponseSchema.parse({
  ...envelope,
  kind: "skill-authoring-copied",
  skill: { ...personalSkill, id: "teacher/t1/copied", name: "copied" },
});
const skillClassesFixture = TeachingClassesResponseSchema.parse({
  protocolVersion: envelope.protocolVersion,
  requestId: envelope.requestId,
  classes: [{ classId: skillClassId, displayName: "Physics" }],
  kind: "teaching-classes-response",
  nextAfterClassId: null,
});
export const skillCatalogFixture = TeachingCatalogResponseSchema.parse({
  ...envelope,
  kind: "teaching-catalog-response",
  nextAfterSkillId: null,
  skills: [
    {
      compatibility: null,
      description: "Bundled testing",
      digest: skillDigest,
      id: "marea/bundled",
      kind: "didactic",
      name: "bundled",
      source: "marea",
    },
  ],
});

export function skillAuthoringClientFixture(): SkillAuthoringClient {
  return {
    catalog: () => Promise.resolve(skillCatalogFixture),
    classes: () => Promise.resolve(skillClassesFixture),
    copy: () => Promise.resolve(skillCopiedFixture),
    readCatalog: () => Promise.resolve({ ...skillReadFixture, editable: false }),
    readPersonal: (_classId: string, slug: string) =>
      Promise.resolve(slug === "missing" ? skillMissingReadFixture : skillReadFixture),
    save: () => Promise.resolve(skillSavedFixture),
    validate: () => Promise.resolve(skillValidatedFixture),
  };
}

export function skillAuthoringStateFixture(
  patch: Partial<SkillAuthoringState> = {},
): SkillAuthoringState {
  return {
    busy: false,
    catalog: skillCatalogFixture.skills,
    catalogLoaded: true,
    classId: skillClassId,
    classes: skillClassesFixture.classes,
    classesLoaded: true,
    dirty: false,
    draft: skillAuthoringDraftFixture,
    editable: true,
    loadedBundle: skillReadFixture.skill,
    pendingTarget: null,
    personalSlug: "testing",
    problem: null,
    recovery: null,
    selectedSkillId: null,
    validation: skillValidatedFixture,
    ...patch,
  };
}

export function skillAuthoringActionsFixture(): SkillAuthoringActions {
  return {
    acceptReadback: () => undefined,
    confirmNavigation: () => Promise.resolve(),
    copySkill: () => Promise.resolve(),
    editDraft: () => undefined,
    loadCatalog: () => Promise.resolve(),
    loadClasses: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    saveDraft: () => Promise.resolve(),
    selectClass: () => Promise.resolve(),
    selectSkill: () => Promise.resolve(),
    startPersonalDraft: () => Promise.resolve(),
    validateDraft: () => Promise.resolve(),
  };
}

export function skillAuthoringPropertiesFixture(
  controller: SkillAuthoringActions = skillAuthoringActionsFixture(),
): SkillAuthoringModuleProperties {
  return { controller, locale: "en", state: skillAuthoringStateFixture() };
}
