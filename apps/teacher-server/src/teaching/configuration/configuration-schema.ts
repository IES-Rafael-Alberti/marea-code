import { createHash } from "node:crypto";

import {
  AdaptiveContextSchema,
  PromptSnapshotSchema,
  RevisionIdSchema,
  SkillBundleSchema,
  ClassInstructionsSchema,
  TeachingSelectionSchema,
  StudentRunSnapshotSchema,
} from "@marea/protocol";
import * as z from "zod";
import { digestSkillFiles } from "../skills/skill-digest.js";
import { PrivateProviderRouteSchema } from "../../model-gateway/route-policy.js";

export { ClassInstructionsSchema, TeachingSelectionSchema } from "@marea/protocol";

const PromptLayerSchema = PromptSnapshotSchema.unwrap()
  .extend({
    name: z.enum(["base", "safety", "mode", "class", "skills", "startup"]),
  })
  .strict()
  .readonly();

export const TeachingSnapshotContentSchema = z
  .object({
    format: z.literal("marea-teaching:1"),
    configurationVersion: RevisionIdSchema,
    routeVersion: RevisionIdSchema,
    layers: z.array(PromptLayerSchema).min(3).max(5).readonly(),
    startup: PromptLayerSchema.nullable(),
    didacticSkills: z
      .array(
        SkillBundleSchema.refine(
          (skill) => skill.kind === "didactic",
          "Didactic material must be didactic.",
        ),
      )
      .max(64)
      .readonly(),
    evaluationSkills: z
      .array(
        SkillBundleSchema.refine(
          (skill) => skill.kind === "evaluation",
          "Evaluation material must be private evaluation content.",
        ),
      )
      .max(1)
      .readonly(),
    automaticEvaluation: z.boolean(),
    adaptive: AdaptiveContextSchema.optional(),
  })
  .strict()
  .refine(
    (content) => !content.automaticEvaluation || content.evaluationSkills.length === 1,
    "Automatic evaluation requires a selected evaluation skill.",
  )
  .refine(
    (content) => content.startup === null || content.startup.name === "startup",
    "The startup task must be a startup layer.",
  )
  .refine(
    (content) =>
      content.layers
        .slice(0, 3)
        .map(({ name }) => name)
        .join(",") === "base,safety,mode" &&
      content.layers.every(({ name }) => name !== "startup") &&
      new Set(content.layers.map(({ name }) => name)).size === content.layers.length,
    "System layers must preserve the base, safety and mode order without duplicates.",
  )
  .refine(
    (content) =>
      [...content.didacticSkills, ...content.evaluationSkills].every(
        (skill) => skill.digest === digestSkillFiles(skill.files),
      ),
    "Skill digests must describe their exact files.",
  )
  .readonly();

export type TeachingSnapshotContent = z.infer<typeof TeachingSnapshotContentSchema>;

export const StoredTeachingConfigurationSchema = z
  .object({
    publicTemplate: StudentRunSnapshotSchema.unwrap().omit({ id: true, startup: true }).readonly(),
    content: TeachingSnapshotContentSchema,
    providerRoute: PrivateProviderRouteSchema,
    classInstructions: ClassInstructionsSchema,
    selection: TeachingSelectionSchema,
  })
  .strict()
  .refine(
    (configuration) =>
      configuration.publicTemplate.prompt.version === configuration.content.configurationVersion,
    "The prompt and configuration revisions must match.",
  )
  .refine(
    (configuration) =>
      configuration.publicTemplate.agentMode === "free"
        ? configuration.content.startup === null &&
          configuration.content.didacticSkills.length === 0
        : configuration.content.startup !== null,
    "The mode, startup task and didactic content must agree.",
  )
  .refine(
    (configuration) =>
      JSON.stringify(configuration.publicTemplate.didacticSkills) ===
      JSON.stringify(
        configuration.content.didacticSkills.map(({ id, digest }) => ({ id, digest })),
      ),
    "Public skill references must match the frozen didactic content.",
  )
  .refine(
    (configuration) =>
      configuration.publicTemplate.prompt.content ===
      configuration.content.layers.map(({ content }) => content).join("\n\n"),
    "The composed prompt must match its frozen layers.",
  )
  .refine(
    (configuration) =>
      [
        configuration.publicTemplate.prompt,
        ...configuration.content.layers,
        ...(configuration.content.startup === null ? [] : [configuration.content.startup]),
      ].every(
        (prompt) =>
          prompt.digest === `sha256:${createHash("sha256").update(prompt.content).digest("hex")}`,
      ),
    "Prompt digests must describe their exact content.",
  )
  .refine(
    (configuration) =>
      JSON.stringify(configuration.selection.evaluation) ===
      JSON.stringify(
        configuration.content.evaluationSkills.map(({ id, digest }) => ({ id, digest })),
      ),
    "Evaluation selection must match frozen private content.",
  )
  .refine(
    (configuration) =>
      configuration.publicTemplate.agentMode === "free" ||
      JSON.stringify(configuration.selection.didactic) ===
        JSON.stringify(configuration.publicTemplate.didacticSkills),
    "Didactic selection must match the active tutoring content.",
  )
  .readonly();

export type StoredTeachingConfiguration = z.infer<typeof StoredTeachingConfigurationSchema>;
