import { describe, expect, it } from "vitest";

import {
  ClassInstructionsSchema,
  MAX_TEACHING_CONFIGURATION_BYTES,
  SaveTeachingConfigurationRequestSchema,
  SaveTeachingConfigurationResponseSchema,
  TEACHING_CATALOG_PAGE_SIZE,
  TeachingCatalogEntrySchema,
  TeachingCatalogQuerySchema,
  TeachingCatalogResponseSchema,
  TeachingClassesQuerySchema,
  TeachingClassesResponseSchema,
  TeachingClassSummarySchema,
  TeachingConfigurationQuerySchema,
  TeachingConfigurationResponseSchema,
  TeachingConfigurationSchema,
  TeachingSelectionSchema,
  TeachingSettingsSchema,
  type ClassInstructions,
  type TeachingSelection,
} from "./index.js";

const envelope = { protocolVersion: "0.1", requestId: "request:settings" };
const skill = { id: "marea/question", digest: `sha256:${"a".repeat(64)}` };
const settings = {
  agentMode: "tutoring",
  classInstructions: { tutoring: "Ask a question.", free: "Support the project." },
  selection: { didactic: [skill], evaluation: [] },
  automaticEvaluation: false,
};
const configuration = { version: "revision:one", settings };
const classId = "class:one";
const summary = { classId, displayName: "Physics" };
const catalogEntry = {
  ...skill,
  name: "question",
  description: "Ask one question.",
  kind: "didactic",
  source: "marea",
  compatibility: null,
};
const classesResponse = {
  ...envelope,
  kind: "teaching-classes-response",
  classes: [summary],
  nextAfterClassId: null,
};
const catalogResponse = {
  ...envelope,
  kind: "teaching-catalog-response",
  classId,
  skills: [catalogEntry],
  nextAfterSkillId: null,
};
const readResponse = {
  ...envelope,
  kind: "teaching-configuration-response",
  classId,
  configuration,
  operatorReady: true,
};
const saveRequest = {
  ...envelope,
  kind: "teaching-configuration-save",
  classId,
  expectedVersion: null,
  settings,
};
const wireCases = [
  [TeachingClassesQuerySchema, { ...envelope, kind: "teaching-classes-query", afterClassId: null }],
  [TeachingClassesResponseSchema, classesResponse],
  [
    TeachingConfigurationQuerySchema,
    { ...envelope, kind: "teaching-configuration-query", classId },
  ],
  [TeachingConfigurationResponseSchema, readResponse],
  [
    TeachingCatalogQuerySchema,
    { ...envelope, kind: "teaching-catalog-query", classId, afterSkillId: null },
  ],
  [TeachingCatalogResponseSchema, catalogResponse],
  [SaveTeachingConfigurationRequestSchema, saveRequest],
  [
    SaveTeachingConfigurationResponseSchema,
    { ...envelope, kind: "teaching-configuration-saved", classId, configuration },
  ],
] as const;

describe("teacher configuration contracts", () => {
  it.each(wireCases)(
    "validates strict, immutable and complete wire envelopes (%#)",
    (schema, input) => {
      const parsed = schema.parse(input);
      expect(parsed).toEqual(input);
      expect(Object.isFrozen(parsed)).toBe(true);
      for (const key of Object.keys(input)) {
        expect(schema.safeParse({ ...input, [key]: undefined }).success).toBe(false);
      }
      for (const patch of [
        { protocolVersion: "future" },
        { requestId: "" },
        { kind: "" },
        { teacherId: "teacher:other" },
        { providerRoute: {} },
        { budget: {} },
      ])
        expect(schema.safeParse({ ...input, ...patch }).success).toBe(false);
    },
  );

  it("models unconfigured classes independently from operator readiness and saves explicit versions", () => {
    for (const operatorReady of [true, false]) {
      expect(
        TeachingConfigurationResponseSchema.parse({
          ...readResponse,
          operatorReady,
          configuration: null,
        }),
      ).toMatchObject({ operatorReady, configuration: null });
    }
    expect(
      SaveTeachingConfigurationRequestSchema.parse({
        ...saveRequest,
        expectedVersion: "revision:old",
      }).expectedVersion,
    ).toBe("revision:old");
    expect(
      SaveTeachingConfigurationRequestSchema.safeParse({ ...saveRequest, expectedVersion: "" })
        .success,
    ).toBe(false);
    expect(TeachingConfigurationSchema.safeParse({ ...configuration, version: "" }).success).toBe(
      false,
    );
    expect(
      SaveTeachingConfigurationResponseSchema.safeParse({
        ...envelope,
        kind: "teaching-configuration-saved",
        classId,
        configuration: null,
      }).success,
    ).toBe(false);
    for (const schema of [TeachingConfigurationQuerySchema, TeachingCatalogQuerySchema]) {
      const input = schema === TeachingConfigurationQuerySchema ? wireCases[2][1] : wireCases[4][1];
      expect(schema.safeParse({ ...input, classId: "bad/id" }).success).toBe(false);
    }
  });

  it("bounds keyset catalog pages without losing continuation identifiers", () => {
    expect(TEACHING_CATALOG_PAGE_SIZE).toBe(100);
    for (const [schema, input, key, entry, cursorKey, cursor] of [
      [
        TeachingClassesResponseSchema,
        classesResponse,
        "classes",
        summary,
        "nextAfterClassId",
        classId,
      ],
      [
        TeachingCatalogResponseSchema,
        catalogResponse,
        "skills",
        catalogEntry,
        "nextAfterSkillId",
        skill.id,
      ],
    ] as const) {
      for (const length of [0, 100]) {
        const value = { ...input, [key]: Array.from({ length }, () => entry), [cursorKey]: cursor };
        const parsed = schema.parse(value);
        expect(parsed).toEqual(value);
        expect(Object.isFrozen(Reflect.get(parsed, key))).toBe(true);
      }
      expect(
        schema.safeParse({ ...input, [key]: Array.from({ length: 101 }, () => entry) }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...input, [cursorKey]: "bad/id" }).success).toBe(false);
    }
    expect(
      TeachingClassesQuerySchema.parse({ ...wireCases[0][1], afterClassId: classId }).afterClassId,
    ).toBe(classId);
    expect(
      TeachingCatalogQuerySchema.parse({ ...wireCases[4][1], afterSkillId: skill.id }).afterSkillId,
    ).toBe(skill.id);
    expect(
      TeachingClassesQuerySchema.safeParse({ ...wireCases[0][1], afterClassId: "" }).success,
    ).toBe(false);
    expect(
      TeachingCatalogQuerySchema.safeParse({ ...wireCases[4][1], afterSkillId: "invalid" }).success,
    ).toBe(false);
  });

  it("keeps public metadata strict and frozen without exposing skill content", () => {
    for (const [schema, input] of [
      [TeachingClassSummarySchema, summary],
      [TeachingCatalogEntrySchema, catalogEntry],
      [TeachingConfigurationSchema, configuration],
      [TeachingSettingsSchema, settings],
    ] as const) {
      expect(schema.parse(input)).toEqual(input);
      expect(Object.isFrozen(schema.parse(input))).toBe(true);
      for (const key of Object.keys(input))
        expect(schema.safeParse({ ...input, [key]: undefined }).success).toBe(false);
      for (const field of ["files", "license", "criteria", "teacherToolPolicy", "providerRoute"])
        expect(schema.safeParse({ ...input, [field]: "private" }).success).toBe(false);
    }
    expect(
      TeachingCatalogEntrySchema.parse({
        ...catalogEntry,
        compatibility: "Marea",
        kind: "evaluation",
        source: "teacher",
      }).compatibility,
    ).toBe("Marea");
    for (const patch of [
      { id: "bad" },
      { name: "" },
      { description: "" },
      { kind: "bad" },
      { source: "bad" },
      { digest: "bad" },
      { compatibility: "x".repeat(501) },
    ])
      expect(TeachingCatalogEntrySchema.safeParse({ ...catalogEntry, ...patch }).success).toBe(
        false,
      );
    expect(TeachingClassSummarySchema.safeParse({ ...summary, displayName: "" }).success).toBe(
      false,
    );
    expect(TeachingSettingsSchema.safeParse({ ...settings, agentMode: "other" }).success).toBe(
      false,
    );
    expect(TeachingSettingsSchema.parse({ ...settings, agentMode: "free" }).selection).toEqual(
      settings.selection,
    );
  });

  it("retains both bounded instruction fields and reserves enough bytes for worst-case JSON escaping", () => {
    const instructions: ClassInstructions = ClassInstructionsSchema.parse({
      tutoring: "",
      free: "",
    });
    expect(instructions).toEqual({ tutoring: "", free: "" });
    expect(Object.isFrozen(instructions)).toBe(true);
    const largest = { tutoring: "\u0001".repeat(262_144), free: "\u0001".repeat(262_144) };
    expect(ClassInstructionsSchema.parse(largest)).toEqual(largest);
    expect(MAX_TEACHING_CONFIGURATION_BYTES).toBe(4_194_304);
    expect(
      new TextEncoder().encode(
        JSON.stringify({ ...saveRequest, settings: { ...settings, classInstructions: largest } }),
      ).byteLength,
    ).toBeLessThan(MAX_TEACHING_CONFIGURATION_BYTES);
    for (const mode of ["tutoring", "free"])
      for (const value of [undefined, 7, "x".repeat(262_145)])
        expect(ClassInstructionsSchema.safeParse({ ...instructions, [mode]: value }).success).toBe(
          false,
        );
    expect(ClassInstructionsSchema.safeParse({ ...instructions, other: "" }).success).toBe(false);
  });

  it("requires unique exact revisions, at most 64 didactic and one evaluation skill", () => {
    const selection: TeachingSelection = TeachingSelectionSchema.parse(settings.selection);
    expect(selection).toEqual(settings.selection);
    for (const value of [
      selection,
      selection.didactic,
      selection.evaluation,
      selection.didactic[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    const didactic = Array.from({ length: 64 }, (_, index) => ({
      ...skill,
      id: `marea/skill-${String(index)}`,
    }));
    const evaluation = [{ ...skill, id: "marea/evaluate" }];
    expect(TeachingSelectionSchema.parse({ didactic, evaluation })).toEqual({
      didactic,
      evaluation,
    });
    expect(TeachingSelectionSchema.parse({ didactic: [], evaluation: [] })).toEqual({
      didactic: [],
      evaluation: [],
    });
    for (const input of [
      { didactic: [...didactic, skill], evaluation },
      { didactic, evaluation: [...evaluation, skill] },
      { didactic: [skill, skill], evaluation: [] },
      { didactic: [skill], evaluation: [skill] },
      { didactic: [{ ...skill, files: [] }], evaluation: [] },
      { didactic: [{ ...skill, digest: "bad" }], evaluation: [] },
      { didactic: [{ ...skill, id: "bad" }], evaluation: [] },
      { didactic: [] },
      { evaluation: [] },
      { didactic: [], evaluation: [], extra: true },
    ])
      expect(TeachingSelectionSchema.safeParse(input).success).toBe(false);
    expect(
      TeachingSelectionSchema.safeParse({ didactic: [skill], evaluation: [skill] }).error?.issues[0]
        ?.message,
    ).toBe("Selected skill identities must be unique.");
    expect(
      TeachingSettingsSchema.parse({
        ...settings,
        automaticEvaluation: true,
        selection: { didactic, evaluation },
      }).automaticEvaluation,
    ).toBe(true);
    expect(
      TeachingSettingsSchema.safeParse({ ...settings, automaticEvaluation: true }).error?.issues[0]
        ?.message,
    ).toBe("Automatic evaluation requires a selected evaluation skill.");
  });
});
