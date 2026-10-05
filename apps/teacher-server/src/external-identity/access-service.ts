import {
  CURRENT_PROTOCOL_VERSION,
  ExternalAccessResponseSchema,
  ExternalRuleValueSchema,
  type ExternalAccessRequest,
  type ExternalAccessResponse,
} from "@marea/protocol";

import type { AuthenticatedIdentity, Clock } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { ConfiguredIdentityProvider, ExternalIdentityRepository } from "./contracts.js";

export interface ExternalAccessServiceDependencies {
  readonly providers: readonly ConfiguredIdentityProvider[];
  readonly repository: ExternalIdentityRepository;
  readonly clock: Clock;
}

/**
 * Lets a class teacher list who may join through each installed provider. Rules of a provider
 * that is no longer installed stay stored but are neither shown nor applied.
 */
export class ExternalAccessService {
  readonly #dependencies: ExternalAccessServiceDependencies;

  public constructor(dependencies: ExternalAccessServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public execute(
    identity: AuthenticatedIdentity,
    request: ExternalAccessRequest,
  ): ExternalAccessResponse {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    const { repository } = this.#dependencies;
    const governed = repository.teacherClassAccess(identity.userId, request.classId);
    const providers = governed && repository.available() ? this.#dependencies.providers : [];
    const rejected: string[] = [];
    if (request.kind === "external-access-change") {
      const provider = providers.find(({ id }) => id === request.providerId);
      if (provider?.descriptor.ruleKinds.some(({ kind }) => kind === request.ruleKind) !== true)
        throw new TeacherDomainError("request.conflict");
      const accepted = new Set<string>();
      for (const value of request.values) {
        const normalized = ExternalRuleValueSchema.safeParse(
          provider.provider.normalizeRule(request.ruleKind, value.trim()),
        );
        if (normalized.success) accepted.add(normalized.data);
        else rejected.push(value);
      }
      if (accepted.size > 0)
        repository.changeRules({
          teacherId: identity.userId,
          classId: request.classId,
          providerId: provider.id,
          kind: request.ruleKind,
          values: [...accepted],
          operation: request.operation,
          now: this.#dependencies.clock.now(),
        });
    }
    return ExternalAccessResponseSchema.parse({
      kind: "external-access",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      classId: request.classId,
      providers: providers.map(({ id, descriptor }) => ({
        providerId: id,
        displayName: descriptor.displayName,
        ruleKinds: descriptor.ruleKinds,
      })),
      rules:
        providers.length === 0
          ? []
          : repository.classRulesFor(
              request.classId,
              providers.map(({ id }) => id),
            ),
      rejected,
    });
  }
}
