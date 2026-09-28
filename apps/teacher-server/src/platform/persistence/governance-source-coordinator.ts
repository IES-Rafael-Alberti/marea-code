import type { GovernanceExchangeSources } from "../../governance/exchange-service.js";
import type { GovernanceClassScope, GovernanceRepository } from "../../governance/contracts.js";
import type { Clock } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { UtcTimestampSchema } from "@marea/protocol";
import { SkillAuthoringStore } from "../../teaching/authoring/skill-authoring-store.boundary.js";
import { CompositeSkillSource } from "../../teaching/skills/composite-skill-source.js";
import type { SkillSource } from "../../teaching/skills/skill-source.js";
import type { TeachingConfigurationRepository } from "../../teaching/configuration/contracts.js";

export interface GovernanceSourceOptions {
  readonly core: SkillSource;
  readonly centers: ReadonlyMap<string, SkillAuthoringStore>;
  readonly teachers: ReadonlyMap<string, SkillAuthoringStore>;
  /** Explicit installation configuration, never an imported reference or path. */
  readonly operatorPersonalOwnerForClass: ReadonlyMap<string, string>;
  readonly repository: GovernanceRepository;
  readonly membership: Pick<TeachingConfigurationRepository, "requireTeacherClass">;
  readonly clock: Clock;
}

export class GovernanceSourceCoordinator implements GovernanceExchangeSources {
  readonly #centers: ReadonlyMap<string, SkillAuthoringStore>;
  // Null is an absent optional owner, never a key in the string-keyed configuration copy.
  readonly #teachers: ReadonlyMap<string | null, SkillAuthoringStore>;
  readonly #operatorOwners: ReadonlyMap<string, string>;
  constructor(private readonly options: GovernanceSourceOptions) {
    this.#centers = new Map(options.centers);
    this.#teachers = new Map(options.teachers);
    this.#operatorOwners = new Map(options.operatorPersonalOwnerForClass);
  }

  withSource<T>(
    scope: GovernanceClassScope,
    operation: (source: SkillSource, assertCurrent: () => undefined) => Promise<T>,
  ): Promise<T> {
    this.options.repository.loadClassForExchange(this.liveScope(scope));
    const personal = this.personalOwner(scope);
    const stores = [this.#centers.get(scope.centerId), this.#teachers.get(personal)].filter(
      (store): store is SkillAuthoringStore => store !== undefined,
    );
    if (new Set(stores.map((store) => store.coordinationKey)).size !== stores.length)
      throw new TeacherDomainError("request.conflict");
    const ordered = [...stores].sort((a, b) =>
      Buffer.compare(Buffer.from(a.coordinationKey), Buffer.from(b.coordinationKey)),
    );
    return this.withOwners(ordered, [this.options.core], async (sources) => {
      let active = true;
      const assertCurrent = () => {
        if (!active) throw new TeacherDomainError("request.conflict");
        this.options.repository.loadClassForExchange(this.liveScope(scope));
        if (this.personalOwner(scope) !== personal)
          throw new TeacherDomainError("dashboard.forbidden");
        return undefined;
      };
      try {
        assertCurrent();
        return await operation(new CompositeSkillSource(sources), assertCurrent);
      } finally {
        active = false;
      }
    });
  }

  private withOwners<T>(
    stores: readonly SkillAuthoringStore[],
    sources: readonly SkillSource[],
    operation: (sources: readonly SkillSource[]) => Promise<T>,
  ): Promise<T> {
    const [first, ...rest] = stores;
    return first === undefined
      ? operation(sources)
      : first.withReadSource((source) => this.withOwners(rest, [...sources, source], operation));
  }

  private liveScope(scope: GovernanceClassScope): GovernanceClassScope {
    return {
      ...scope,
      context: { ...scope.context, now: UtcTimestampSchema.parse(this.options.clock.now()) },
    };
  }

  private personalOwner(scope: GovernanceClassScope): string | null {
    const authority = scope.context.authority;
    if (authority.kind === "operator") return this.#operatorOwners.get(scope.classId) ?? null;
    const userId = authority.session.identity.userId;
    try {
      this.options.membership.requireTeacherClass(userId, scope.classId);
      return userId;
    } catch (error) {
      if (error instanceof TeacherDomainError && error.code === "dashboard.forbidden") return null;
      throw error;
    }
  }
}
