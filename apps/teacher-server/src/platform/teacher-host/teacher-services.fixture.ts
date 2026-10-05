import type { ConfiguredIdentityProvider } from "../../external-identity/contracts.js";
import type { ServerSettingsStore } from "../../server-settings/contracts.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaEightDatabase } from "../../../test-support/schema-eight-fixture.js";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import {
  createHmacSecretDigest,
  cryptoIdGenerator,
  cryptoSecretIssuer,
} from "../../identity/system-security.boundary.js";
import { RecordingProvider, request } from "../../product-http/product-http.fixture.js";
import { createTeacherProductHttp } from "../../product-http/teacher-product-http.boundary.js";
import {
  MemorySkillSource,
  operatorConfiguration,
  syntheticOperatorPolicy,
  syntheticSkill,
} from "../../teaching/configuration/dashboard-module.fixture.js";
import { withoutDeletionAuthority } from "../persistence/identity-creation-guard.js";
import { SqliteTeachingConfigurationRepository } from "../persistence/sqlite-teaching-configuration-repository.js";
import { composeTeacherServices } from "./teacher-services.js";

/** A composed teacher host over a seeded schema-eight database, for integration tests. */
export const NOW = "2026-09-14T10:00:00.000Z";

export function seededDatabase(configuration = teachingConfiguration("free")) {
  const database = schemaEightDatabase();
  database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:one', 'one', 'Physics')",
  );
  database.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('t1', 'teacher', 'hash:teacher-password', 'teacher', 'Teacher', NULL), ('s1', 'student', 'hash:student-password', 'student', 'Student', 'class:one')",
  );
  database.execute(
    "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:one')",
  );
  new SqliteTeachingConfigurationRepository(database).saveRevision({
    classId: "class:one",
    createdAt: NOW,
    configuration,
    expectedVersion: null,
    teacherId: "t1",
  });
  return database;
}

export async function composedHost(
  database = seededDatabase(),
  centers: ReadonlyMap<string, string> = new Map(),
  teacherRoot = mkdtempSync(join(tmpdir(), "marea-host-teacher-")),
  settings?: ServerSettingsStore,
  identityProviders?: readonly ConfiguredIdentityProvider[],
) {
  const provider = new RecordingProvider();
  const composed = await composeTeacherServices({
    ...(settings === undefined ? {} : { serverSettings: { store: settings, catalog: [] } }),
    ...(identityProviders === undefined ? {} : { identityProviders }),
    educationalInsights: {},
    database,
    clock: { now: () => NOW },
    ids: cryptoIdGenerator,
    secrets: cryptoSecretIssuer,
    digest: createHmacSecretDigest(new Uint8Array(32).fill(7)),
    passwords: {
      hash: (secret) => Promise.resolve(`hash:${secret}`),
      verify: (secret, hash) => Promise.resolve(hash === `hash:${secret}`),
    },
    dummyPasswordHash: "hash:dummy",
    operator: operatorConfiguration({
      "class:one": syntheticOperatorPolicy,
      "class:two": syntheticOperatorPolicy,
    }),
    skills: {
      core: new MemorySkillSource([syntheticSkill("evaluation", "evaluate")]),
      centers,
      teachers: new Map([["t1", teacherRoot]]),
      operatorPersonalOwnerForClass: new Map(),
    },
    providers: { resolve: (id) => (id === "synthetic-provider" ? provider : undefined) },
    retry: { wait: () => Promise.resolve() },
    identities: withoutDeletionAuthority(),
    evaluationIntervalMs: 60_000,
    onEvaluationError: () => undefined,
  });
  const app = createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: ["https://dashboard.test"],
    serverVersion: "0.2.0",
    services: composed.services,
    governance: composed.governance,
  });
  const call = async (path: string, body: object, credential?: string) => {
    const response = await app.fetch(request(path, body, credential));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { app, call, composed, database, provider };
}

export function login(loginName: string, password: string) {
  return {
    credentials: { login: loginName, password },
    kind: "credential-login",
    protocolVersion: "0.1",
    requestId: `request:login-${loginName}`,
  };
}
