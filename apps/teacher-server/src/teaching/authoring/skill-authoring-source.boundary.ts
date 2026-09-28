import type { SkillOwnerIdentity } from "./authoring-validation.boundary.js";
import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";
import type {
  SkillBundle,
  SkillId,
  SkillKind,
  SkillSource,
  SkillSummary,
} from "../skills/skill-source.js";

/**
 * Owner-scoped authoring facade for host composition. It implements the same
 * SkillSource port as read-only catalogs and shares the store's owner gate,
 * so hosts must use this facade instead of an uncoordinated directory reader.
 */
export class SkillAuthoringSource implements SkillSource {
  readonly #store: SkillAuthoringStore;

  constructor(rootDirectory: string, owner: SkillOwnerIdentity) {
    this.#store = new SkillAuthoringStore(rootDirectory, owner);
  }

  async initialize(): Promise<void> {
    await this.#store.initialize();
  }

  list(kind: SkillKind): Promise<readonly SkillSummary[]> {
    return this.#store.list(kind);
  }

  load(id: SkillId): Promise<SkillBundle | null> {
    return this.#store.read(id);
  }
}
