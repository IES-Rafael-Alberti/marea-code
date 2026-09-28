import { Sha256DigestSchema, SkillIdSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { teachingConfiguration, teachingSkill } from "../../../test-support/teaching-fixture.js";
import {
  ClassInstructionsSchema,
  StoredTeachingConfigurationSchema,
  TeachingSelectionSchema,
  TeachingSnapshotContentSchema,
} from "./configuration-schema.js";

const zeroDigest = Sha256DigestSchema.parse(`sha256:${"0".repeat(64)}`);

describe("stored teaching configuration", () => {
  it.each(["tutoring", "free"] as const)(
    "freezes and preserves the complete %s configuration",
    (mode) => {
      const fixture = teachingConfiguration(mode);
      const parsed = StoredTeachingConfigurationSchema.parse(fixture);
      expect(parsed).toEqual(fixture);
      for (const value of [
        parsed,
        parsed.publicTemplate,
        parsed.content,
        parsed.providerRoute,
        parsed.classInstructions,
        parsed.selection,
        parsed.selection.didactic,
        parsed.selection.didactic[0],
        parsed.selection.evaluation,
        parsed.content.layers,
        ...parsed.content.layers,
        parsed.content.didacticSkills,
        parsed.content.evaluationSkills,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      expect(parsed.content.automaticEvaluation).toBe(false);
    },
  );

  it("requires unique bounded selections and keeps evaluation selection singular", () => {
    const configuration = teachingConfiguration();
    const revision = configuration.selection.didactic[0];
    if (revision === undefined) throw new Error("Fixture selection missing.");
    expect(() =>
      TeachingSelectionSchema.parse({ didactic: [revision, revision], evaluation: [] }),
    ).toThrow("Selected skill identities must be unique.");
    expect(() =>
      TeachingSelectionSchema.parse({ didactic: [revision], evaluation: [revision] }),
    ).toThrow("Selected skill identities must be unique.");
    expect(
      TeachingSelectionSchema.safeParse({
        didactic: [],
        evaluation: [revision, { ...revision, id: "marea/other" }],
      }).success,
    ).toBe(false);
    expect(
      TeachingSelectionSchema.safeParse({
        didactic: Array.from({ length: 65 }, (_, index) => ({
          ...revision,
          id: `marea/skill-${String(index)}`,
        })),
        evaluation: [],
      }).success,
    ).toBe(false);
    expect(
      TeachingSelectionSchema.safeParse({ ...configuration.selection, extra: true }).success,
    ).toBe(false);
    expect(
      TeachingSelectionSchema.safeParse({
        didactic: [{ ...revision, extra: true }],
        evaluation: [],
      }).success,
    ).toBe(false);
    expect(TeachingSelectionSchema.parse({ didactic: [], evaluation: [] })).toEqual({
      didactic: [],
      evaluation: [],
    });
  });

  it("bounds both editable instruction profiles and rejects unknown fields", () => {
    expect(ClassInstructionsSchema.parse({ tutoring: "", free: "" })).toEqual({
      tutoring: "",
      free: "",
    });
    for (const mode of ["tutoring", "free"] as const)
      expect(
        ClassInstructionsSchema.safeParse({ tutoring: "", free: "", [mode]: "x".repeat(262_145) })
          .success,
      ).toBe(false);
    expect(
      ClassInstructionsSchema.safeParse({ tutoring: "", free: "", secret: "private" }).success,
    ).toBe(false);
  });

  it("allows automatic evaluation only with a frozen evaluation method", () => {
    const content = teachingConfiguration().content;
    expect(
      TeachingSnapshotContentSchema.parse({ ...content, automaticEvaluation: true })
        .automaticEvaluation,
    ).toBe(true);
    expect(() =>
      TeachingSnapshotContentSchema.parse({
        ...content,
        automaticEvaluation: true,
        evaluationSkills: [],
      }),
    ).toThrow("Automatic evaluation requires a selected evaluation skill.");
  });

  it("separates didactic and evaluation bundles and verifies their exact digests", () => {
    const content = teachingConfiguration().content;
    expect(() =>
      TeachingSnapshotContentSchema.parse({
        ...content,
        didacticSkills: [teachingSkill("evaluation")],
      }),
    ).toThrow("Didactic material must be didactic.");
    expect(() =>
      TeachingSnapshotContentSchema.parse({
        ...content,
        evaluationSkills: [teachingSkill("didactic")],
      }),
    ).toThrow("Evaluation material must be private evaluation content.");
    expect(() =>
      TeachingSnapshotContentSchema.parse({
        ...content,
        didacticSkills: [{ ...teachingSkill("didactic"), digest: zeroDigest }],
      }),
    ).toThrow("Skill digests must describe their exact files.");
    expect(() =>
      TeachingSnapshotContentSchema.parse({
        ...content,
        evaluationSkills: [{ ...teachingSkill("evaluation"), digest: zeroDigest }],
      }),
    ).toThrow("Skill digests must describe their exact files.");
  });

  it("checks startup identity, layer order, duplication and separation", () => {
    const content = teachingConfiguration().content;
    expect(() =>
      TeachingSnapshotContentSchema.parse({
        ...content,
        startup: { ...content.startup, name: "base" },
      }),
    ).toThrow("The startup task must be a startup layer.");
    for (const layers of [
      [...content.layers].reverse(),
      [...content.layers.slice(0, 3), content.layers[0]],
      [...content.layers.slice(0, 3), content.startup],
    ])
      expect(() => TeachingSnapshotContentSchema.parse({ ...content, layers })).toThrow(
        "System layers must preserve the base, safety and mode order without duplicates.",
      );
    expect(TeachingSnapshotContentSchema.safeParse({ ...content, layers: [] }).success).toBe(false);
    expect(
      TeachingSnapshotContentSchema.safeParse({
        ...content,
        layers: [...content.layers, ...content.layers],
      }).success,
    ).toBe(false);
    expect(TeachingSnapshotContentSchema.safeParse({ ...content, extra: true }).success).toBe(
      false,
    );
  });

  it("requires matching revisions, modes and public references", () => {
    const configuration = teachingConfiguration();
    const free = teachingConfiguration("free");
    expect(() =>
      StoredTeachingConfigurationSchema.parse({
        ...free,
        content: { ...free.content, startup: configuration.content.startup },
      }),
    ).toThrow("The mode, startup task and didactic content must agree.");
    expect(() =>
      StoredTeachingConfigurationSchema.parse({
        ...configuration,
        publicTemplate: {
          ...configuration.publicTemplate,
          prompt: { ...configuration.publicTemplate.prompt, version: "other:revision" },
        },
      }),
    ).toThrow("The prompt and configuration revisions must match.");
    for (const content of [configuration.content, { ...configuration.content, startup: null }])
      expect(() =>
        StoredTeachingConfigurationSchema.parse({
          ...configuration,
          publicTemplate: { ...configuration.publicTemplate, agentMode: "free" },
          content,
        }),
      ).toThrow("The mode, startup task and didactic content must agree.");
    expect(() =>
      StoredTeachingConfigurationSchema.parse({
        ...configuration,
        content: { ...configuration.content, startup: null },
      }),
    ).toThrow("The mode, startup task and didactic content must agree.");
    expect(() =>
      StoredTeachingConfigurationSchema.parse({
        ...configuration,
        publicTemplate: { ...configuration.publicTemplate, didacticSkills: [] },
      }),
    ).toThrow("Public skill references must match the frozen didactic content.");
  });

  it("checks exact prompt composition and every prompt digest", () => {
    const configuration = teachingConfiguration();
    expect(() =>
      StoredTeachingConfigurationSchema.parse({
        ...configuration,
        publicTemplate: {
          ...configuration.publicTemplate,
          prompt: { ...configuration.publicTemplate.prompt, content: "Changed prompt" },
        },
      }),
    ).toThrow("The composed prompt must match its frozen layers.");
    for (const candidate of [
      {
        ...configuration,
        publicTemplate: {
          ...configuration.publicTemplate,
          prompt: { ...configuration.publicTemplate.prompt, digest: zeroDigest },
        },
      },
      {
        ...configuration,
        content: {
          ...configuration.content,
          layers: configuration.content.layers.map((layer) => ({ ...layer, digest: zeroDigest })),
        },
      },
      {
        ...configuration,
        content: {
          ...configuration.content,
          startup: { ...configuration.content.startup, digest: zeroDigest },
        },
      },
    ])
      expect(() => StoredTeachingConfigurationSchema.parse(candidate)).toThrow(
        "Prompt digests must describe their exact content.",
      );
  });

  it("binds both saved selections to their captured content", () => {
    const configuration = teachingConfiguration();
    expect(() =>
      StoredTeachingConfigurationSchema.parse({
        ...configuration,
        selection: { ...configuration.selection, evaluation: [] },
      }),
    ).toThrow("Evaluation selection must match frozen private content.");
    expect(() =>
      StoredTeachingConfigurationSchema.parse({
        ...configuration,
        selection: { ...configuration.selection, didactic: [] },
      }),
    ).toThrow("Didactic selection must match the active tutoring content.");
    const different = { id: SkillIdSchema.parse("marea/other"), digest: zeroDigest };
    expect(() =>
      StoredTeachingConfigurationSchema.parse({
        ...configuration,
        selection: { ...configuration.selection, evaluation: [different] },
      }),
    ).toThrow("Evaluation selection must match frozen private content.");
  });

  it("rejects undeclared configuration, template and route fields", () => {
    const configuration = teachingConfiguration();
    for (const candidate of [
      { ...configuration, extra: true },
      {
        ...configuration,
        publicTemplate: { ...configuration.publicTemplate, id: "snapshot:not-a-template" },
      },
      {
        ...configuration,
        providerRoute: { ...configuration.providerRoute, apiKey: "private-key" },
      },
    ])
      expect(StoredTeachingConfigurationSchema.safeParse(candidate).success).toBe(false);
  });
});
