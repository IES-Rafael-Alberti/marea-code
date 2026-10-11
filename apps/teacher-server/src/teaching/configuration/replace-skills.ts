import type {
  TeachingSnapshotContent,
  StoredTeachingConfiguration,
} from "./configuration-schema.js";
import { StoredTeachingConfigurationSchema } from "./configuration-schema.js";
import { composeTeachingPrompt } from "../prompts/prompt-composer.js";

/** Rebuilds both prompt and frozen content; the current class policy always remains authoritative. */
export function replaceTeachingSkills(
  configuration: StoredTeachingConfiguration,
  didactic: TeachingSnapshotContent["didacticSkills"],
  evaluation: TeachingSnapshotContent["evaluationSkills"],
  version: string,
): StoredTeachingConfiguration {
  const active = configuration.publicTemplate.agentMode === "tutoring" ? didactic : [];
  const composed = composeTeachingPrompt({
    agentMode: configuration.publicTemplate.agentMode,
    classVersion: version,
    classInstructions: configuration.classInstructions,
    didacticSkills: active,
  });
  return StoredTeachingConfigurationSchema.parse({
    ...configuration,
    publicTemplate: {
      ...configuration.publicTemplate,
      prompt: composed.prompt,
      didacticSkills: active.map(({ id, digest }) => ({ id, digest })),
    },
    content: {
      ...configuration.content,
      configurationVersion: version,
      layers: composed.layers,
      startup: composed.startup,
      didacticSkills: active,
      evaluationSkills: evaluation,
    },
    selection: {
      didactic: didactic.map(({ id, digest }) => ({ id, digest })),
      evaluation: evaluation.map(({ id, digest }) => ({ id, digest })),
    },
  });
}
