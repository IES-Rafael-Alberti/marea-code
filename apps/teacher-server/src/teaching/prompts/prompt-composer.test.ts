import { createHash } from "node:crypto";

import { Sha256DigestSchema, SkillIdSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { SkillSummary } from "../skills/index.js";
import { composeTeachingPrompt, type PromptCompositionInput } from "./prompt-composer.js";

const skill: SkillSummary = {
  id: SkillIdSchema.parse("teacher/t1/testing"),
  name: "testing",
  kind: "didactic",
  source: "teacher",
  description: "Testing exercises",
  digest: Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`),
  license: null,
  compatibility: null,
  criteria: [{ code: "C1", statement: "Internal criterion", levels: null }],
};
const input: PromptCompositionInput = {
  agentMode: "tutoring",
  classVersion: "class:revision:1",
  classInstructions: {
    tutoring: "Practice testing this week.",
    free: "Work on the requested code.",
  },
  didacticSkills: [skill],
};

describe("versioned prompt composition", () => {
  it("composes ordered layers and keeps startup outside the system prompt", () => {
    const result = composeTeachingPrompt(input);
    expect(result.layers.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "base", version: "marea:base:2" },
      { name: "safety", version: "marea:safety:2" },
      { name: "mode", version: "marea:tutoring:2" },
      { name: "class", version: "class:revision:1" },
      { name: "skills", version: "class:revision:1" },
    ]);
    expect(result.prompt.version).toBe(input.classVersion);
    expect(result.prompt.content).toBe(result.layers.map(({ content }) => content).join("\n\n"));
    expect(result.layers[3]?.content).toBe(input.classInstructions.tutoring);
    expect(result.layers[4]?.content).toBe(
      JSON.stringify([{ id: skill.id, description: skill.description, digest: skill.digest }]),
    );
    expect(result.prompt.content).not.toContain("Internal criterion");
    expect(result.prompt.content).not.toContain(input.classInstructions.free);
    expect(result.startup).toMatchObject({ name: "startup", version: "marea:startup:2" });
    expect(result.prompt.content).not.toContain(result.startup?.content);
    for (const entry of [...result.layers, result.prompt, result.startup]) {
      if (entry === null) throw new Error("Tutoring must have a startup task.");
      expect(entry.digest).toBe(
        `sha256:${createHash("sha256").update(entry.content).digest("hex")}`,
      );
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.layers)).toBe(true);
  });

  it("pins packaged instructions and their versions", () => {
    const result = composeTeachingPrompt(input);
    expect(result.layers.slice(0, 3).map(({ version, digest }) => ({ version, digest }))).toEqual([
      {
        version: "marea:base:2",
        digest: "sha256:c83a0eab33478ff70df856c3e9284dc4d19a05b5a330b19b967bd7b874dfe12e",
      },
      {
        version: "marea:safety:2",
        digest: "sha256:4e0c6db79c6851b0b38af98e17976c52153e12ea8fdc67fff8d6447d26a16a39",
      },
      {
        version: "marea:tutoring:2",
        digest: "sha256:1277eea7181974add0a83bbb86dbee99da7c8b5f1d9100c746ddc370cba43a1b",
      },
    ]);
    expect(result.startup?.digest).toBe(
      "sha256:297da49c55319bb9c3142bf07be1264c5d6cc95119fe75792b3573033b74702a",
    );
    const free = composeTeachingPrompt({ ...input, agentMode: "free" });
    expect(free.layers[2]).toMatchObject({
      version: "marea:free:2",
      digest: "sha256:c46f46d93a21a6d026ea745038e08f5550fba7d833aa0d56296701b7bdde0cca",
    });
  });

  it("free mode has no didactic manifest, tutor instructions or startup", () => {
    const result = composeTeachingPrompt({ ...input, agentMode: "free" });
    expect(result.startup).toBeNull();
    expect(result.layers.map(({ name }) => name)).toEqual(["base", "safety", "mode", "class"]);
    expect(result.layers[3]?.content).toBe(input.classInstructions.free);
    expect(result.prompt.content).not.toContain(skill.id);
    expect(result.prompt.content).not.toContain(input.classInstructions.tutoring);
    expect(result.prompt.content).not.toContain("Elige un único objetivo pedagógico");
    expect(result.prompt.content).toContain("Respeta las denegaciones");
  });

  it("omits empty optional layers while preserving the class revision", () => {
    const result = composeTeachingPrompt({
      ...input,
      classInstructions: { tutoring: "", free: "" },
      didacticSkills: [],
    });
    expect(result.layers.map(({ name }) => name)).toEqual(["base", "safety", "mode"]);
    expect(result.prompt.version).toBe(input.classVersion);
  });

  it("copies mutable caller data and detects changed class text in the next composition", () => {
    const instructions = { ...input.classInstructions };
    const mutableSkill = { ...skill };
    const mutableInput = {
      ...input,
      classInstructions: instructions,
      didacticSkills: [mutableSkill],
    };
    const before = composeTeachingPrompt(mutableInput);
    const bytes = JSON.stringify(before);
    instructions.tutoring = "Changed class instructions.";
    mutableSkill.description = "Changed description";
    mutableInput.classVersion = "class:revision:2";
    const after = composeTeachingPrompt(mutableInput);
    expect(JSON.stringify(before)).toBe(bytes);
    expect(after.prompt.version).toBe("class:revision:2");
    expect(after.prompt.digest).not.toBe(before.prompt.digest);
    expect(after.layers[4]?.content).toContain("Changed description");
  });

  it("rejects evaluation material in the didactic manifest", () => {
    expect(() =>
      composeTeachingPrompt({ ...input, didacticSkills: [{ ...skill, kind: "evaluation" }] }),
    ).toThrow("Only didactic skills may enter a student prompt.");
  });

  it("rejects invalid revisions and oversized final prompts", () => {
    expect(() => composeTeachingPrompt({ ...input, classVersion: "../bad" })).toThrow();
    expect(() =>
      composeTeachingPrompt({
        ...input,
        classInstructions: { ...input.classInstructions, tutoring: "x".repeat(256 * 1_024) },
      }),
    ).toThrow("Prompt content must be at most 262144 UTF-8 bytes.");
  });
});

it.each(["tutoring", "free"] as const)(
  "uses complete %s mode text exactly once and keeps the independent safety layer",
  (agentMode) => {
    const instructions = {
      format: "complete-mode" as const,
      tutoring: "Custom guided instructions.",
      free: "Custom free instructions.",
    };
    const result = composeTeachingPrompt({ ...input, agentMode, classInstructions: instructions });
    expect(result.layers[2]).toMatchObject({
      name: "mode",
      version: input.classVersion,
      content: instructions[agentMode],
    });
    expect(result.layers.some(({ name }) => name === "class")).toBe(false);
    expect(result.prompt.content.split(instructions[agentMode])).toHaveLength(2);
    expect(result.layers[0]?.name).toBe("base");
    expect(result.layers[1]?.content).toContain(
      "Las autorizaciones las decide Marea fuera del modelo",
    );
    expect(result.prompt.content).not.toContain("Actúa como tutor de programación");
    expect(result.prompt.content).not.toContain(
      "Actúa como agente de programación dirigido por el usuario",
    );
  },
);
