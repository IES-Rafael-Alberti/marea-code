import type * as z from "zod";
import type {
  ConfiguredTeachingRouteSchema,
  SaveClassTeachingSchema,
} from "./configuration-service.js";
import { StoredTeachingConfigurationSchema } from "./configuration-schema.js";
import { materializeTeachingSkills, type SkillSource } from "../skills/index.js";
import { composeTeachingPrompt } from "../prompts/prompt-composer.js";

/** Shared content construction; callers supply their own live authorization gate. */
export async function materializeConfiguration(
  request: z.infer<typeof SaveClassTeachingSchema>,
  route: z.infer<typeof ConfiguredTeachingRouteSchema>,
  source: SkillSource,
  revision: string,
) {
  const captured = await materializeTeachingSkills(source, {
    agentMode: request.agentMode,
    ...request.selection,
  });
  const composed = composeTeachingPrompt({
    agentMode: request.agentMode,
    classVersion: revision,
    classInstructions: request.classInstructions,
    didacticSkills: captured.didactic,
  });
  return StoredTeachingConfigurationSchema.parse({
    publicTemplate: {
      agentMode: request.agentMode,
      modelAlias: route.modelAlias,
      prompt: composed.prompt,
      didacticSkills: captured.didactic.map(({ id, digest }) => ({ id, digest })),
      teacherToolPolicy: request.teacherToolPolicy,
    },
    content: {
      format: "marea-teaching:1",
      configurationVersion: revision,
      routeVersion: route.version,
      layers: composed.layers,
      startup: composed.startup,
      didacticSkills: captured.didactic,
      evaluationSkills: captured.evaluation,
      automaticEvaluation: request.automaticEvaluation,
    },
    providerRoute: route.providerRoute,
    classInstructions: request.classInstructions,
    selection: request.selection,
  });
}
