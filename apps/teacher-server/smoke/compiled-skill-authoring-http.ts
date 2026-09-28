import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillIdSchema } from "@marea/protocol";
import { initializeSqliteStorage } from "@marea/sqlite-storage";

import { IdentityService } from "../src/identity/identity-service.js";
import { createHmacSecretDigest } from "../src/identity/system-security.boundary.js";
import { TeacherDomainError } from "../src/identity/errors.js";
import { SqliteIdentityRepository } from "../src/platform/persistence/sqlite-identity-repository.js";
import { SqliteTeachingConfigurationRepository } from "../src/platform/persistence/sqlite-teaching-configuration-repository.js";
import { createTeacherProductHttp } from "../src/product-http/index.js";
import { createServices, RecordingProvider } from "../src/product-http/product-http.fixture.js";
import { createProductSkillAuthoringService } from "../src/teaching/authoring-runtime/skill-authoring-service.js";
import {
  draft,
  request as authoringRequest,
  writeCoreSkill,
} from "../src/teaching/authoring-runtime/skill-authoring-service.fixture.js";
import { SkillAuthoringSource } from "../src/teaching/authoring/skill-authoring-source.boundary.js";
import { SkillAuthoringStore } from "../src/teaching/authoring/skill-authoring-store.boundary.js";
import {
  BundledSkillSource,
  CompositeSkillSource,
  DirectorySkillSource,
} from "../src/teaching/skills/index.js";

const token = "compiled-synthetic-teacher-session";
const origin = "https://dashboard.test";

let root: string | undefined;
let sqliteStorage: ReturnType<typeof initializeSqliteStorage> | undefined;
let server: Bun.Server<undefined> | undefined;

try {
  root = await mkdtemp(join(tmpdir(), "marea-teaching-compiled-authoring-"));
  const bundledRoot = join(root, "bundled");
  const centerRoot = join(root, "center");
  const teacherRoot = join(root, "teacher");
  await writeCoreSkill(bundledRoot);
  await writeCoreSkill(centerRoot);

  sqliteStorage = initializeSqliteStorage({ databasePath: join(root, "teacher.sqlite") });
  const database = sqliteStorage.database;
  database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:one', 'one', 'one'), ('class:two', 'two', 'two')",
  );
  database.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('t1', 't1', 'synthetic', 'teacher', 't1', NULL), ('t2', 't2', 'synthetic', 'teacher', 't2', NULL), ('s1', 's1', 'synthetic', 'student', 's1', 'class:one'), ('s2', 's2', 'synthetic', 'student', 's2', 'class:two')",
  );
  database.execute(
    "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:one'), ('t2', 'class:two')",
  );
  const digest = createHmacSecretDigest(new Uint8Array(32).fill(7));
  const identityRepository = new SqliteIdentityRepository(database);
  identityRepository.createSession({
    expiresAt: "2099-01-01T00:00:00.000Z",
    issuedAt: "2026-09-10T08:00:00.000Z",
    sessionId: "session:compiled",
    tokenHash: digest.digest(token),
    userId: "t1",
  });
  const identity = new IdentityService({
    clock: { now: () => "2026-09-10T08:01:00.000Z" },
    digest,
    dummyPasswordHash: "synthetic-dummy",
    ids: { createId: () => "synthetic-id" },
    passwords: { hash: () => Promise.resolve("synthetic"), verify: () => Promise.resolve(false) },
    repository: identityRepository,
    secrets: { issue: () => "synthetic-secret" },
  });

  const store = new SkillAuthoringStore(teacherRoot, { id: "t1", source: "teacher" });
  await store.initialize();
  const teacherSource = new SkillAuthoringSource(teacherRoot, { id: "t1", source: "teacher" });
  await teacherSource.initialize();
  const catalog = new CompositeSkillSource([
    new BundledSkillSource(bundledRoot),
    new DirectorySkillSource(centerRoot, { id: "center:one", source: "center" }),
    teacherSource,
  ]);
  const membership = new SqliteTeachingConfigurationRepository(database);
  const skillAuthoring = createProductSkillAuthoringService({
    membership,
    sourceForTeacherClass(teacherId, classId) {
      if (teacherId !== "t1" || classId !== "class:one")
        throw new TeacherDomainError("dashboard.forbidden");
      return catalog;
    },
    writerForTeacher(teacherId) {
      if (teacherId !== "t1") throw new TeacherDomainError("dashboard.forbidden");
      return store;
    },
  });
  const base = createServices(new RecordingProvider());
  const app = createTeacherProductHttp({
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [origin],
    serverVersion: "0.2.0",
    services: {
      ...base,
      identity: { ...base.identity, authenticate: (value) => identity.authenticate(value) },
      skillAuthoring,
    },
  });

  server = Bun.serve({
    fetch: (request) => app.fetch(request),
    hostname: "127.0.0.1",
    port: 0,
  });
  const baseHeaders = {
    Cookie: `marea_teacher_session=${token}`,
    host: "127.0.0.1",
    origin,
    "content-type": "application/json",
  };
  const call = async (path: string, body: object, headers = baseHeaders): Promise<Response> =>
    withTimeout(
      fetch(`${server?.url.origin ?? ""}${path}`, {
        body: JSON.stringify(body),
        headers,
        method: "POST",
      }),
      `HTTP ${path}`,
    );

  const savedResponse = await call(
    "/api/v1/dashboard/skill-authoring/save",
    authoringRequest("class:one", "skill-authoring-save", {
      draft: draft("didactic", "compiled"),
      expectedDigest: null,
    }),
  );
  requireCondition(savedResponse.status === 200, `create failed: ${String(savedResponse.status)}`);
  const saved = (await savedResponse.json()) as { skill: { digest: string } };

  const read = await call(
    "/api/v1/dashboard/skill-authoring/read",
    authoringRequest("class:one", "skill-authoring-read", {
      target: { scope: "personal", slug: "compiled" },
    }),
  );
  requireCondition(read.status === 200, "read failed");

  const validated = await call(
    "/api/v1/dashboard/skill-authoring/validate",
    authoringRequest("class:one", "skill-authoring-validate", {
      draft: draft("didactic", "compiled", "validated"),
    }),
  );
  requireCondition(validated.status === 200, "validation failed");

  const replaced = await call(
    "/api/v1/dashboard/skill-authoring/save",
    authoringRequest("class:one", "skill-authoring-save", {
      draft: draft("didactic", "compiled", "replaced"),
      expectedDigest: saved.skill.digest,
    }),
  );
  requireCondition(replaced.status === 200, "replace failed");

  const core = await catalog.load(SkillIdSchema.parse("marea/core-practice"));
  const copied = await call(
    "/api/v1/dashboard/skill-authoring/copy",
    authoringRequest("class:one", "skill-authoring-copy", {
      slug: "compiled-copy",
      sourceDigest: core?.digest,
      sourceSkillId: "marea/core-practice",
    }),
  );
  requireCondition(copied.status === 200, "copy failed");

  const denied = await call(
    "/api/v1/dashboard/skill-authoring/read",
    authoringRequest("class:one", "skill-authoring-read", {
      target: { scope: "personal", slug: "compiled" },
    }),
    { ...baseHeaders, Cookie: "marea_teacher_session=invalid" },
  );
  requireCondition(denied.status === 401, "invalid current authentication was accepted");

  database.execute(
    "DELETE FROM marea_teacher_classes WHERE teacher_id = 't1' AND class_id = 'class:one'",
  );
  const revoked = await call(
    "/api/v1/dashboard/skill-authoring/read",
    authoringRequest("class:one", "skill-authoring-read", {
      target: { scope: "personal", slug: "compiled" },
    }),
  );
  requireCondition(revoked.status === 403, "revoked SQLite membership was accepted");
  process.stdout.write(
    "Compiled authoring HTTP smoke passed: current-auth SQLite create/read/validate/replace/copy/denial.\n",
  );
} finally {
  if (server !== undefined) await server.stop(true);
  if (sqliteStorage !== undefined) sqliteStorage.close();
  if (root !== undefined) await rm(root, { force: true, recursive: true });
}

async function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  milliseconds = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out.`));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
