import { SkillBundleSchema, type AgentMode } from "@marea/protocol";

import type { StoredTeachingConfiguration } from "../src/teaching/configuration/configuration-schema.js";
import type { TeachingConfigurationService } from "../src/teaching/configuration/configuration-service.js";
import { composeTeachingPrompt } from "../src/teaching/prompts/prompt-composer.js";
import { digestSkillFiles } from "../src/teaching/skills/skill-digest.js";
import type { SkillBundle, SkillKind } from "../src/teaching/skills/skill-source.js";

export function teachingSkill(kind: SkillKind): SkillBundle {
  const name = kind === "didactic" ? "testing" : "review";
  const content = `---\nname: ${name}\ndescription: Synthetic ${kind}\n---\n\nSynthetic ${kind} instructions.\n`;
  const resource = `Frozen ${kind} resource.\n`;
  const files = [
    { path: "SKILL.md", content, sizeBytes: new TextEncoder().encode(content).byteLength },
    {
      path: "resources/guide.txt",
      content: resource,
      sizeBytes: new TextEncoder().encode(resource).byteLength,
    },
  ];
  return SkillBundleSchema.parse({
    id: kind === "didactic" ? "teacher/t1/testing" : "marea/review",
    name,
    description: `Synthetic ${kind}`,
    kind,
    source: kind === "didactic" ? "teacher" : "marea",
    digest: digestSkillFiles(files),
    license: null,
    compatibility: null,
    criteria: [],
    files,
  });
}

export function teachingInput(
  agentMode: AgentMode = "tutoring",
): Parameters<TeachingConfigurationService["save"]>[1] {
  const didactic = teachingSkill("didactic");
  const evaluation = teachingSkill("evaluation");
  return {
    classId: "class:one",
    expectedVersion: null,
    agentMode,
    classInstructions: {
      tutoring: "Class exercise instructions.",
      free: "Class coding instructions.",
    },
    selection: {
      didactic: [{ id: didactic.id, digest: didactic.digest }],
      evaluation: [{ id: evaluation.id, digest: evaluation.digest }],
    },
    teacherToolPolicy: {
      version: "policy:1",
      restrictions: [{ tool: "workspace.write", effect: "require-approval" }],
    },
    automaticEvaluation: false,
  };
}

export function teachingConfiguration(
  agentMode: AgentMode = "tutoring",
  revision = "revision:1",
): StoredTeachingConfiguration {
  const input = teachingInput(agentMode);
  const didacticSkills = agentMode === "free" ? [] : [teachingSkill("didactic")];
  const composed = composeTeachingPrompt({
    agentMode,
    classVersion: revision,
    classInstructions: input.classInstructions,
    didacticSkills,
  });
  return {
    publicTemplate: {
      agentMode,
      modelAlias: "marea",
      prompt: composed.prompt,
      didacticSkills: didacticSkills.map(({ id, digest }) => ({ id, digest })),
      teacherToolPolicy: input.teacherToolPolicy,
    },
    providerRoute: { model: "synthetic-model", providerId: "synthetic-provider" },
    content: {
      format: "marea-teaching:1",
      configurationVersion: revision,
      routeVersion: "route:1",
      layers: composed.layers,
      startup: composed.startup,
      didacticSkills,
      evaluationSkills: [teachingSkill("evaluation")],
      automaticEvaluation: false,
    },
    classInstructions: input.classInstructions,
    selection: input.selection,
  };
}
