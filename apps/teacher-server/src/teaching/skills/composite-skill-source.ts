import { BundledSkillError } from "./errors.js";
import type { SkillBundle, SkillId, SkillKind, SkillSource, SkillSummary } from "./skill-source.js";

/** Combines already-authorized sources without source-order precedence. */
export class CompositeSkillSource implements SkillSource {
  readonly #sources: readonly SkillSource[];

  constructor(sources: readonly SkillSource[]) {
    this.#sources = Object.freeze([...sources]);
  }

  async list(kind: SkillKind): Promise<readonly SkillSummary[]> {
    const all: SkillSummary[] = [];
    const ids = new Set<SkillId>();
    for (const source of this.#sources) {
      for (const sourceKind of ["didactic", "evaluation"] as const) {
        for (const summary of await source.list(sourceKind)) {
          if (ids.has(summary.id)) throw duplicateSkill(summary.id);
          ids.add(summary.id);
          if (summary.kind === kind) all.push(summary);
        }
      }
    }
    // Stryker disable next-line EqualityOperator: Duplicate IDs are rejected above, so < and <= are equivalent for every reachable pair.
    return Object.freeze(all.sort((left, right) => (left.id < right.id ? -1 : 1)));
  }

  async load(id: SkillId): Promise<SkillBundle | null> {
    let result: SkillBundle | null = null;
    for (const source of this.#sources) {
      const bundle = await source.load(id);
      if (bundle === null) continue;
      if (result !== null) throw duplicateSkill(id);
      result = bundle;
    }
    return result;
  }
}

function duplicateSkill(id: SkillId): BundledSkillError {
  return new BundledSkillError(
    "DUPLICATE_SKILL_ID",
    id,
    `Skill ${id} appears in more than one catalog entry; select distinct source identities.`,
  );
}
