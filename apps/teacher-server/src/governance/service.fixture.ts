import { ClassExchangeSchema, RevisionIdSchema, RequestIdSchema } from "@marea/protocol";
import {
  governanceFixture,
  seedGovernancePilot,
  GOVERNANCE_NOW,
} from "../platform/persistence/governance-repository.fixture.js";
import { withoutDeletionAuthority } from "../platform/persistence/identity-creation-guard.js";
import { createSqliteGovernanceRepository } from "../platform/persistence/sqlite-governance-repository.js";
import { GovernanceSourceCoordinator } from "../platform/persistence/governance-source-coordinator.js";
import { SqliteTeachingConfigurationRepository } from "../platform/persistence/sqlite-teaching-configuration-repository.js";
import {
  MemorySkillSource,
  syntheticOperatorPolicy,
  syntheticSkill,
} from "../teaching/configuration/dashboard-module.fixture.js";
import type { TeachingOperatorPolicy } from "../teaching/configuration/dashboard-contracts.js";
import { createGovernanceService } from "./service.boundary.js";
import { GovernanceExchangeService } from "./exchange-service.js";
import type { GovernanceIdGenerator } from "./authority.js";

export function governanceServiceFixture() {
  const f = governanceFixture();
  const admin = seedGovernancePilot(f);
  if (admin.authority.kind !== "administrator") throw new Error("Expected administrator session.");
  let now: string = GOVERNANCE_NOW;
  let policy: TeachingOperatorPolicy | null = structuredClone(syntheticOperatorPolicy);
  let counter = 0;
  let beforeLoad = () => Promise.resolve();
  let beforeHash = () => Promise.resolve();
  const evaluator = syntheticSkill("evaluation", "evaluate");
  const memory = new MemorySkillSource([evaluator]);
  const source = {
    list: memory.list.bind(memory),
    load: async (skillId: Parameters<typeof memory.load>[0]) => {
      await beforeLoad();
      return memory.load(skillId);
    },
  };
  const repository = createSqliteGovernanceRepository(
    f.database,
    () => policy !== null,
    withoutDeletionAuthority(),
  );
  const clock = { now: () => now };
  const ids: GovernanceIdGenerator = {
    createId: (kind) => RevisionIdSchema.parse(`${kind}:service:${String(++counter)}`),
  };
  const sources = new GovernanceSourceCoordinator({
    core: source,
    repository,
    clock,
    centers: new Map(),
    teachers: new Map(),
    operatorPersonalOwnerForClass: new Map(),
    membership: new SqliteTeachingConfigurationRepository(f.database),
  });
  const dependencies = {
    repository,
    clock,
    ids,
    sources,
    operator: { forClass: () => policy },
    passwords: {
      hash: async (secret: string) => {
        await beforeHash();
        return `hashed:${secret}`;
      },
      verify: () => Promise.resolve(false),
    },
    secrets: { issue: () => `random-secret:${String(++counter)}` },
  };
  return {
    ...f,
    repository,
    service: createGovernanceService(dependencies),
    exchange: new GovernanceExchangeService(dependencies),
    session: admin.authority.session,
    admin,
    evaluator,
    ids,
    source,
    clock,
    dependencies,
    advance: (time: string) => {
      now = time;
    },
    policy: (value: TeachingOperatorPolicy | null) => {
      policy = value;
    },
    beforeLoad: (run: () => Promise<void>) => {
      beforeLoad = run;
    },
    beforeHash: (run: () => Promise<void>) => {
      beforeHash = run;
    },
  };
}

export const exchangePackage = ClassExchangeSchema.parse({
  format: "marea-class-exchange:1",
  source: { displayName: "Source class" },
  agentMode: "free",
  classInstructions: { tutoring: "Imported tutor", free: "Imported free" },
  selection: { didactic: [], evaluation: [] },
});
export function governanceEnvelope(kind: string) {
  return {
    protocolVersion: "0.1" as const,
    requestId: RequestIdSchema.parse("request:service"),
    kind,
  };
}
