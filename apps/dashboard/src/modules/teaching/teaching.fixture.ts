import {
  TeachingSettingsSchema,
  TeachingConfigurationResponseSchema,
  TeachingClassesResponseSchema,
  TeachingCatalogResponseSchema,
  SaveTeachingConfigurationResponseSchema,
} from "@marea/protocol";

import type {
  TeachingActions,
  TeachingClient,
  TeachingModuleProperties,
  TeachingState,
} from "./teaching-contracts.js";

export const teachingSettingsFixture = TeachingSettingsSchema.parse({
  agentMode: "tutoring",
  classInstructions: { tutoring: "Ask one question.", free: "Support the project." },
  selection: { didactic: [], evaluation: [] },
  automaticEvaluation: false,
});
const envelope = { protocolVersion: "0.1", requestId: "request:teaching" };
export const teachingReadFixture = TeachingConfigurationResponseSchema.parse({
  ...envelope,
  kind: "teaching-configuration-response",
  classId: "class:one",
  configuration: { version: "revision:one", settings: teachingSettingsFixture },
  operatorReady: true,
});
export const teachingClassesFixture = TeachingClassesResponseSchema.parse({
  ...envelope,
  kind: "teaching-classes-response",
  classes: [{ classId: "class:one", displayName: "Physics" }],
  nextAfterClassId: null,
});
export const teachingCatalogFixture = TeachingCatalogResponseSchema.parse({
  ...envelope,
  kind: "teaching-catalog-response",
  classId: "class:one",
  skills: [],
  nextAfterSkillId: null,
});

export function teachingClientFixture(): TeachingClient {
  return {
    classes: () => Promise.resolve(teachingClassesFixture),
    read: () => Promise.resolve(teachingReadFixture),
    catalog: () => Promise.resolve(teachingCatalogFixture),
    save: () =>
      Promise.resolve(
        SaveTeachingConfigurationResponseSchema.parse({
          ...envelope,
          kind: "teaching-configuration-saved",
          classId: "class:one",
          configuration: teachingReadFixture.configuration,
        }),
      ),
  };
}

export function teachingStateFixture(patch: Partial<TeachingState> = {}): TeachingState {
  return {
    busy: false,
    classes: teachingClassesFixture.classes,
    classesLoaded: true,
    classId: "class:one",
    catalog: teachingCatalogFixture.skills,
    configuration: teachingReadFixture.configuration,
    operatorReady: true,
    draft: teachingSettingsFixture,
    dirty: false,
    problem: null,
    recovery: null,
    pendingClassId: null,
    ...patch,
  };
}

export function teachingPropertiesFixture(controller: TeachingActions): TeachingModuleProperties {
  return { locale: "en", state: teachingStateFixture(), controller };
}
