import { SkillBundleSchema, type AgentMode, type Sha256Digest } from "@marea/protocol";

import { digestSkillFiles } from "./skill-digest.js";
import type { SkillBundle, SkillId, SkillKind, SkillSource } from "./skill-source.js";

export interface SelectedSkillRevision {
  readonly id: SkillId;
  readonly digest: Sha256Digest;
}

export interface TeachingSkillSelection {
  readonly agentMode: AgentMode;
  readonly didactic: readonly SelectedSkillRevision[];
  readonly evaluation: readonly SelectedSkillRevision[];
}

/** Private capture: never serialize this whole object into a student response. */
export interface MaterializedTeachingSkills {
  readonly didactic: readonly SkillBundle[];
  readonly evaluation: readonly SkillBundle[];
}

export class SkillSnapshotError extends Error {
  constructor(
    readonly skillId: SkillId,
    readonly reason: "duplicate" | "missing" | "changed",
  ) {
    super(`Cannot capture skill ${skillId}: ${reason}.`);
    this.name = "SkillSnapshotError";
  }
}

/** Resolve a saved selection atomically: no partial capture escapes on failure. */
export async function materializeTeachingSkills(
  source: SkillSource,
  selection: TeachingSkillSelection,
): Promise<MaterializedTeachingSkills> {
  // Copy before the first await: caller edits cannot alter an in-flight capture.
  const didactic = selection.agentMode === "free" ? [] : copySelection(selection.didactic);
  const evaluation = copySelection(selection.evaluation);
  const ids = new Set<SkillId>();
  for (const revision of [...didactic, ...evaluation]) {
    if (ids.has(revision.id)) throw new SkillSnapshotError(revision.id, "duplicate");
    ids.add(revision.id);
  }
  return Object.freeze({
    didactic: await captureKind(source, didactic, "didactic"),
    evaluation: await captureKind(source, evaluation, "evaluation"),
  });
}

function copySelection(selection: readonly SelectedSkillRevision[]): SelectedSkillRevision[] {
  return selection.map((revision) => ({ ...revision }));
}

async function captureKind(
  source: SkillSource,
  selection: readonly SelectedSkillRevision[],
  kind: SkillKind,
): Promise<readonly SkillBundle[]> {
  const bundles: SkillBundle[] = [];
  for (const revision of selection) {
    const bundle = await source.load(revision.id);
    if (bundle === null) throw new SkillSnapshotError(revision.id, "missing");
    if (
      bundle.id !== revision.id ||
      bundle.kind !== kind ||
      bundle.digest !== revision.digest ||
      digestSkillFiles(bundle.files) !== revision.digest
    ) {
      throw new SkillSnapshotError(revision.id, "changed");
    }
    bundles.push(SkillBundleSchema.parse(bundle));
  }
  return Object.freeze(bundles);
}
