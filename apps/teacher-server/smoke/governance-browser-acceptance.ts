import { RevisionIdSchema } from "@marea/protocol";

import { createGovernanceService } from "../src/governance/service.boundary.js";
import type { GovernanceIdGenerator } from "../src/governance/authority.js";
import {
  createHmacSecretDigest,
  cryptoIdGenerator,
  cryptoSecretIssuer,
  systemClock,
} from "../src/identity/system-security.boundary.js";
import { runAcceptanceHost, syntheticIdentity } from "./browser-acceptance-host.js";
import { governanceFixture } from "../src/platform/persistence/governance-repository.fixture.js";
import { GovernanceSourceCoordinator } from "../src/platform/persistence/governance-source-coordinator.js";
import { createSqliteGovernanceRepository } from "../src/platform/persistence/sqlite-governance-repository.js";
import { SqliteGovernanceSessionResolver } from "../src/platform/persistence/sqlite-governance-session-resolver.js";
import { SqliteIdentityRepository } from "../src/platform/persistence/sqlite-identity-repository.js";
import { SqliteTeachingConfigurationRepository } from "../src/platform/persistence/sqlite-teaching-configuration-repository.js";
import { createTeacherProductHttp } from "../src/product-http/index.js";
import { withoutDeletionAuthority } from "../src/platform/persistence/identity-creation-guard.js";
import { createServices, RecordingProvider } from "../src/product-http/product-http.fixture.js";
import {
  MemorySkillSource,
  syntheticOperatorPolicy,
  syntheticSkill,
} from "../src/teaching/configuration/dashboard-module.fixture.js";

// Synthetic installation: two centers, two classes in A, one in B, one administrator of both
// centers and one ordinary teacher. All governance writes after seeding go through the browser.
const f = governanceFixture();
const { database, operator } = f;
f.createCenter("center:a");
f.createCenter("center:b");
f.createClass("center:a", "class:a");
f.createClass("center:a", "class:second");
f.createClass("center:b", "class:b");
f.administrator("center:a", "user:admin");
const association = operator.commitAssociateAccount({
  context: f.operatorContext(),
  centerId: RevisionIdSchema.parse("center:b"),
  userId: RevisionIdSchema.parse("user:admin"),
  expectedVersion: null,
});
operator.commitSetAdministrator({
  context: f.operatorContext(),
  centerId: RevisionIdSchema.parse("center:b"),
  userId: RevisionIdSchema.parse("user:admin"),
  capability: "administrator",
  expectedVersion: association.version,
});
f.createAccount("center:a", "user:teacher", "teacher", "class:a");
f.activate("center:a", "user:teacher");
for (const [table, id, name] of [
  ["marea_centers", "center:a", "North Center"],
  ["marea_centers", "center:b", "South Center"],
  ["marea_classes", "class:a", "Physics"],
  ["marea_classes", "class:second", "Chemistry"],
  ["marea_classes", "class:b", "Biology"],
  ["marea_users", "user:admin", "Ada Admin"],
  ["marea_users", "user:teacher", "Tomas Teacher"],
] as const)
  database.execute(`UPDATE ${table} SET display_name = ?1 WHERE id = ?2`, [name, id]);
database.execute(
  "UPDATE marea_users SET login = 'admin1', password_hash = 'synthetic-password' WHERE id = 'user:admin'",
);
database.execute(
  "UPDATE marea_users SET login = 'teacher1', password_hash = 'synthetic-password' WHERE id = 'user:teacher'",
);

const digest = createHmacSecretDigest(new Uint8Array(32).fill(29));
const identity = syntheticIdentity(new SqliteIdentityRepository(database), digest);

const repository = createSqliteGovernanceRepository(
  database,
  () => true,
  withoutDeletionAuthority(),
);
const evaluator = syntheticSkill("evaluation", "evaluate");
const ids: GovernanceIdGenerator = {
  createId: (kind) => RevisionIdSchema.parse(`${kind}:${cryptoIdGenerator.createId("revision")}`),
};
const governanceDependencies = {
  repository,
  clock: systemClock,
  ids,
  sources: new GovernanceSourceCoordinator({
    core: new MemorySkillSource([evaluator]),
    repository,
    clock: systemClock,
    centers: new Map(),
    teachers: new Map(),
    operatorPersonalOwnerForClass: new Map(),
    membership: new SqliteTeachingConfigurationRepository(database),
  }),
  operator: { forClass: () => structuredClone(syntheticOperatorPolicy) },
  passwords: {
    hash: (secret: string) => Promise.resolve(`synthetic-hash:${secret}`),
    verify: () => Promise.resolve(false),
  },
  secrets: cryptoSecretIssuer,
};

await runAcceptanceHost({
  label: "GOVERNANCE",
  proofPrefixes: ["/api/v1/dashboard/governance/"],
  createApp: (port) =>
    createTeacherProductHttp({
      allowedHosts: [`127.0.0.1:${String(port)}`],
      allowedOrigins: [`http://127.0.0.1:${String(port)}`],
      secureDashboardCookie: false,
      serverVersion: "0.2.0",
      services: { ...createServices(new RecordingProvider()), identity },
      governance: {
        service: createGovernanceService(governanceDependencies),
        sessions: new SqliteGovernanceSessionResolver(database, repository),
        digest,
        clock: systemClock,
      },
    }),
  close: () => {
    database.close();
  },
});
