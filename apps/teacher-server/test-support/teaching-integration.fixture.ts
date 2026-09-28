import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OpenRunRequestSchema } from "@marea/protocol";
import { createMigrationCatalog } from "@marea/sqlite-storage/migrations";

import type { AuthenticatedIdentity } from "../src/identity/contracts.js";
import { TeacherDomainError } from "../src/identity/errors.js";
import {
  createHmacSecretDigest,
  cryptoIdGenerator,
  cryptoSecretIssuer,
} from "../src/identity/system-security.boundary.js";
import { SqliteRunSessionRepository } from "../src/platform/persistence/sqlite-run-session-repository.js";
import { SqliteRunSkillRepository } from "../src/platform/persistence/sqlite-run-skill-repository.js";
import { SqliteTeachingConfigurationRepository } from "../src/platform/persistence/sqlite-teaching-configuration-repository.js";
import { RunSessionService } from "../src/sessions/run-session-service.js";
import { TeachingConfigurationService } from "../src/teaching/configuration/configuration-service.js";
import { ConfigurationSnapshotSource } from "../src/teaching/configuration/configuration-snapshot-source.js";
import type { SkillBundle, SkillSource } from "../src/teaching/skills/index.js";
import { RunSkillService } from "../src/teaching/skills/run-skill-service.js";
import type { NodeSqliteTestDatabase } from "./node-sqlite-database.boundary.js";

export const teacher: AuthenticatedIdentity = {
  userId: "t1",
  role: "teacher",
  classId: null,
  displayName: "Synthetic teacher",
};
export const student: AuthenticatedIdentity = {
  userId: "s1",
  role: "student",
  classId: "class:one",
  displayName: "Synthetic student",
};
export const clock = { now: () => "2026-09-07T12:00:00.000Z" };

export function servicesFor(database: NodeSqliteTestDatabase, source: SkillSource) {
  const configurations = new SqliteTeachingConfigurationRepository(database);
  const snapshots = new ConfigurationSnapshotSource(configurations);
  const runs = new RunSessionService({
    clock,
    ids: cryptoIdGenerator,
    secrets: cryptoSecretIssuer,
    digest: createHmacSecretDigest(new Uint8Array(32).fill(42)),
    repository: new SqliteRunSessionRepository(database),
    snapshots,
  });
  const teaching = new TeachingConfigurationService({
    clock,
    ids: cryptoIdGenerator,
    repository: configurations,
    routes: {
      forClass: () => ({
        version: "route:1",
        modelAlias: "marea",
        providerRoute: { providerId: "synthetic-provider", model: "synthetic-model" },
      }),
    },
    skills: {
      forTeacherClass: (teacherId, classId) => {
        if (teacherId !== "t1" || classId !== "class:one")
          throw new TeacherDomainError("dashboard.forbidden");
        return source;
      },
    },
  });
  const skills = new RunSkillService(new SqliteRunSkillRepository(database), runs);
  return { configurations, snapshots, runs, teaching, skills };
}

export async function writeCatalog(root: string, bundle: SkillBundle): Promise<void> {
  for (const kind of ["didactic", "evaluation"]) await mkdir(join(root, kind), { recursive: true });
  for (const file of bundle.files) {
    const target = join(root, bundle.kind, bundle.name, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

export function newRun(key: string) {
  return OpenRunRequestSchema.parse({
    protocolVersion: "0.1",
    clientVersion: "0.0.0",
    requestId: `request:${key}`,
    idempotencyKey: `open:${key}`,
    clientSessionId: "client:one",
    project: { displayName: "Synthetic project" },
    intent: { kind: "new" },
  });
}

export function seedTeachingDatabase(database: NodeSqliteTestDatabase): void {
  for (const migration of createMigrationCatalog())
    for (const statement of migration.statements) database.executeScript(statement);
  for (const [id, seed] of [
    ["class:one", "one"],
    ["class:two", "two"],
  ] as const)
    database.execute("INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, ?2, ?2)", [
      id,
      seed,
    ]);
  for (const [id, role, classId] of [
    ["t1", "teacher", null],
    ["t2", "teacher", null],
    ["s1", "student", "class:one"],
    ["s2", "student", "class:two"],
  ] as const)
    database.execute(
      "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES (?1, ?1, 'synthetic-hash', ?2, ?1, ?3)",
      [id, role, classId],
    );
  database.execute(
    "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:one'), ('t2', 'class:two')",
  );
}
