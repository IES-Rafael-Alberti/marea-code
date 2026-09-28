import { SkillIdSchema } from "@marea/protocol";

import { BundledSkillSource } from "./bundled-skill-source.boundary.js";
import type { SkillBundle, SkillId, SkillKind, SkillSource, SkillSummary } from "./skill-source.js";

export interface SkillDirectoryOwner {
  readonly source: "teacher" | "center";
  readonly id: string;
}

/** Reads one authorized owner's directory; authorization belongs to the caller. */
export class DirectorySkillSource implements SkillSource {
  readonly #reader: BundledSkillSource;
  readonly #owner: SkillDirectoryOwner;
  readonly #prefix: string;

  constructor(rootDirectory: string, owner: SkillDirectoryOwner) {
    SkillIdSchema.parse(`${owner.source}/${owner.id}/identity-probe`);
    this.#owner = Object.freeze({ ...owner });
    this.#prefix = `${owner.source}/${owner.id}/`;
    this.#reader = new BundledSkillSource(rootDirectory);
  }

  async list(kind: SkillKind): Promise<readonly SkillSummary[]> {
    const summaries = await this.#reader.list(kind);
    return Object.freeze(summaries.map((summary) => this.#withOwner(summary)));
  }

  async load(id: SkillId): Promise<SkillBundle | null> {
    if (!id.startsWith(this.#prefix)) return null;
    const bundledId = SkillIdSchema.parse(`marea/${id.slice(this.#prefix.length)}`);
    const bundle = await this.#reader.load(bundledId);
    return bundle === null ? null : this.#withOwner(bundle);
  }

  #withOwner<T extends SkillSummary>(skill: T): T {
    return Object.freeze({
      ...skill,
      id: SkillIdSchema.parse(`${this.#prefix}${skill.name}`),
      source: this.#owner.source,
    });
  }
}
