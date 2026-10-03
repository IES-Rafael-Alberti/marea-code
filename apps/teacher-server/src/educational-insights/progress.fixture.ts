import { EvaluationDraftSchema, SnapshotIdSchema, StudentRunSnapshotSchema } from "@marea/protocol";
import { EVALUATION_DRAFT, NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { student } from "../../test-support/teaching-integration.fixture.js";
import { teachingConfiguration } from "../../test-support/teaching-fixture.js";
import { captureEvaluationInput } from "../platform/persistence/sqlite-evaluation-input.js";
import type { fixture } from "./insights.fixture.js";

interface Criterion {
  code: string;
  statement: string;
  levels: readonly [string, string, string, string] | null;
}
export function capture(
  f: ReturnType<typeof fixture>,
  statement = "Validate boundaries",
  criteria: Criterion[] = [{ code: "C1", statement, levels: null }],
) {
  const configuration = teachingConfiguration();
  const skill = configuration.content.didacticSkills[0];
  if (skill === undefined) throw new Error("skill");
  const teaching = {
    ...configuration.content,
    didacticSkills: [{ ...skill, criteria }],
  };
  const snapshot = StudentRunSnapshotSchema.parse({
    ...configuration.publicTemplate,
    id: SnapshotIdSchema.parse("snapshot:adaptive"),
  });
  return f.progress.capture(
    { snapshot, providerRoute: configuration.providerRoute, teaching },
    student,
  );
}
export function targetOf(captured: ReturnType<typeof capture>) {
  const target = captured.teaching?.adaptive?.targets[0];
  if (target === undefined) throw new Error("target");
  return target;
}
export function enabled(f: ReturnType<typeof fixture>) {
  f.progress.configure("class:one", { map: true, adaptive: true }, "initial");
}
export function approve(
  f: ReturnType<typeof fixture>,
  captured: ReturnType<typeof capture>,
  passed = true,
) {
  const input = captureEvaluationInput(f.database, "run:b");
  const target = targetOf(captured);
  if (input.content === null || captured.teaching === undefined) throw new Error("input");
  const draft = EvaluationDraftSchema.parse({
    ...EVALUATION_DRAFT,
    criteria: [
      {
        skillId: target.skillId,
        code: target.code,
        result: passed ? "passed" : "not-passed",
        confidence: "high",
        evidence: "Observed boundary test",
        levelAttempted: target.target,
        learningNote: "Practice an empty collection next.",
      },
    ],
  });
  f.progress.apply(
    { ...input, mode: "tutoring", content: { ...input.content, teaching: captured.teaching } },
    draft,
    teacher.userId,
    NOW,
  );
}
/** The reviewed run as a tutoring evaluation input carrying the captured adaptive targets. */
export function adaptiveInput(f: ReturnType<typeof fixture>, captured: ReturnType<typeof capture>) {
  const input = captureEvaluationInput(f.database, "run:b");
  if (input.content === null || captured.teaching === undefined) throw new Error("input");
  return {
    ...input,
    mode: "tutoring" as const,
    content: { ...input.content, teaching: captured.teaching },
  };
}
export function passedAssessment(target: ReturnType<typeof targetOf>) {
  return {
    skillId: target.skillId,
    code: target.code,
    result: "passed" as const,
    confidence: "high" as const,
    evidence: "Observed",
    levelAttempted: target.target,
  };
}
