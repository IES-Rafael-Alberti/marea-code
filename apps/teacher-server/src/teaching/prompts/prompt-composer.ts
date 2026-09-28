import { createHash } from "node:crypto";

import {
  PromptSnapshotSchema,
  Sha256DigestSchema,
  FREE_INSTRUCTIONS,
  TUTORING_INSTRUCTIONS,
  type ClassInstructions,
  type AgentMode,
  type StudentRunSnapshot,
} from "@marea/protocol";

import type { SkillSummary } from "../skills/index.js";
import { BASE_INSTRUCTIONS, SAFETY_INSTRUCTIONS, STARTUP_INSTRUCTIONS } from "./default-layers.js";

type PromptSnapshot = StudentRunSnapshot["prompt"];

interface VersionedPromptLayer extends PromptSnapshot {
  readonly name: "base" | "safety" | "mode" | "class" | "skills" | "startup";
}

export interface PromptCompositionInput {
  readonly agentMode: AgentMode;
  readonly classVersion: string;
  readonly classInstructions: ClassInstructions;
  readonly didacticSkills: readonly SkillSummary[];
}

export interface ComposedTeachingPrompt {
  readonly prompt: PromptSnapshot;
  readonly layers: readonly VersionedPromptLayer[];
  /** Execute once as a read-only logical turn; never fabricate a user message. */
  readonly startup: VersionedPromptLayer | null;
}

function layer(
  name: VersionedPromptLayer["name"],
  version: string,
  content: string,
): VersionedPromptLayer {
  return Object.freeze({ name, ...prompt(version, content) });
}

function prompt(version: string, content: string): PromptSnapshot {
  const digest = Sha256DigestSchema.parse(
    `sha256:${createHash("sha256").update(content).digest("hex")}`,
  );
  return PromptSnapshotSchema.parse({ version, content, digest });
}

function manifestEntry(skill: SkillSummary): Pick<SkillSummary, "id" | "description" | "digest"> {
  if (skill.kind !== "didactic")
    throw new TypeError("Only didactic skills may enter a student prompt.");
  return { id: skill.id, description: skill.description, digest: skill.digest };
}

export function composeTeachingPrompt(input: PromptCompositionInput): ComposedTeachingPrompt {
  const tutoring = input.agentMode === "tutoring";
  const complete = input.classInstructions.format === "complete-mode";
  const classInstructions = input.classInstructions[input.agentMode];
  const layers: VersionedPromptLayer[] = [
    layer("base", "marea:base:2", BASE_INSTRUCTIONS),
    layer("safety", "marea:safety:2", SAFETY_INSTRUCTIONS),
    layer(
      "mode",
      complete ? input.classVersion : `marea:${input.agentMode}:2`,
      complete ? classInstructions : tutoring ? TUTORING_INSTRUCTIONS : FREE_INSTRUCTIONS,
    ),
  ];
  if (!complete && classInstructions.length > 0)
    layers.push(layer("class", input.classVersion, classInstructions));
  if (tutoring && input.didacticSkills.length > 0) {
    layers.push(
      layer("skills", input.classVersion, JSON.stringify(input.didacticSkills.map(manifestEntry))),
    );
  }
  const content = layers.map((entry) => entry.content).join("\n\n");
  return Object.freeze({
    prompt: prompt(input.classVersion, content),
    layers: Object.freeze(layers),
    startup: tutoring ? layer("startup", "marea:startup:2", STARTUP_INSTRUCTIONS) : null,
  });
}
