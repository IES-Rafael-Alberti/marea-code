import { join } from "node:path";

import {
  createHmacSecretDigest,
  cryptoIdGenerator,
  systemClock,
} from "../src/identity/system-security.boundary.js";
import { TeacherDomainError } from "../src/identity/errors.js";
import { SqliteIdentityRepository } from "../src/platform/persistence/sqlite-identity-repository.js";
import { SqliteTeachingConfigurationRepository } from "../src/platform/persistence/sqlite-teaching-configuration-repository.js";
import { SqliteTeachingDashboardRepository } from "../src/platform/persistence/sqlite-teaching-dashboard-repository.js";
import { createTeacherProductHttp } from "../src/product-http/index.js";
import { createServices, RecordingProvider } from "../src/product-http/product-http.fixture.js";
import { createProductSkillAuthoringService } from "../src/teaching/authoring-runtime/skill-authoring-service.js";
import { writeCoreSkill } from "../src/teaching/authoring-runtime/skill-authoring-service.fixture.js";
import { SkillAuthoringSource } from "../src/teaching/authoring/skill-authoring-source.boundary.js";
import { SkillAuthoringStore } from "../src/teaching/authoring/skill-authoring-store.boundary.js";
import { createTeachingConfigurationModule } from "../src/teaching/configuration/dashboard-module.js";
import {
  BundledSkillSource,
  CompositeSkillSource,
  DirectorySkillSource,
} from "../src/teaching/skills/index.js";
import { NodeSqliteTestDatabase } from "../test-support/node-sqlite-database.boundary.js";
import { seedTeachingDatabase } from "../test-support/teaching-integration.fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../test-support/usage-fixture.js";
import { acceptanceRoot, runAcceptanceHost, syntheticIdentity } from "./browser-acceptance-host.js";

const root = acceptanceRoot("TEACHING");
const database = new NodeSqliteTestDatabase(join(root, "state.sqlite"));
const provider = new RecordingProvider();

seedTeachingDatabase(database);
database.execute(
  "UPDATE marea_users SET password_hash = 'synthetic-password' WHERE id IN ('t1', 't2', 's1', 's2')",
);
database.execute("UPDATE marea_users SET login = 'teacher1' WHERE id = 't1'");
database.execute("UPDATE marea_users SET login = 'teacher2' WHERE id = 't2'");
database.execute("UPDATE marea_users SET login = 'student1' WHERE id = 's1'");
database.execute(
  "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:two')",
);
const identityRepository = new SqliteIdentityRepository(database);
const digest = createHmacSecretDigest(new Uint8Array(32).fill(23));
const identity = syntheticIdentity(identityRepository, digest);

const bundledRoot = join(root, "bundled");
const teacherRoot = join(root, "teacher");
await writeCoreSkill(bundledRoot);
const store = new SkillAuthoringStore(teacherRoot, { id: "t1", source: "teacher" });
await store.initialize();
const teacherSource = new SkillAuthoringSource(teacherRoot, { id: "t1", source: "teacher" });
await teacherSource.initialize();
const catalogs = new Map<string, CompositeSkillSource>();
for (const suffix of ["one", "two"]) {
  const centerRoot = join(root, `center-${suffix}`);
  await writeCoreSkill(centerRoot);
  catalogs.set(
    `class:${suffix}`,
    new CompositeSkillSource([
      teacherSource,
      new DirectorySkillSource(centerRoot, { id: `center:${suffix}`, source: "center" }),
      new BundledSkillSource(bundledRoot),
    ]),
  );
}
function sourceForTeacherClass(teacherId: string, classId: string): CompositeSkillSource {
  const source = catalogs.get(classId);
  if (teacherId !== "t1" || source === undefined)
    throw new TeacherDomainError("dashboard.forbidden");
  return source;
}
const configurationRepository = new SqliteTeachingConfigurationRepository(database);
const dashboardRepository = new SqliteTeachingDashboardRepository(database);
const operatorPolicy = {
  route: {
    modelAlias: "marea" as const,
    providerRoute: {
      budget: SYNTHETIC_ROUTE_BUDGET,
      model: "synthetic-model",
      providerId: "synthetic-provider",
    },
    version: "route:teaching",
  },
  teacherToolPolicy: {
    restrictions: [{ effect: "require-approval" as const, tool: "workspace.write" }],
    version: "policy:teaching",
  },
};
const teaching = createTeachingConfigurationModule({
  clock: systemClock,
  ids: cryptoIdGenerator,
  directory: dashboardRepository,
  operator: {
    forClass: (classId) => (["class:one", "class:two"].includes(classId) ? operatorPolicy : null),
  },
  repository: configurationRepository,
  skills: { forTeacherClass: sourceForTeacherClass },
}).service;
const skillAuthoring = createProductSkillAuthoringService({
  membership: configurationRepository,
  sourceForTeacherClass,
  writerForTeacher: (teacherId) => {
    if (teacherId !== "t1") throw new TeacherDomainError("dashboard.forbidden");
    return store;
  },
});
const base = createServices(provider);
// Both configurations are created through authenticated browser HTTP, not seeded writes.

await runAcceptanceHost({
  label: "TEACHING",
  proofPrefixes: [
    "/api/v1/dashboard/teaching/",
    "/api/v1/dashboard/skill-authoring/",
    "/api/v1/dashboard/governance/",
  ],
  createApp: (port) =>
    createTeacherProductHttp({
      allowedHosts: [`127.0.0.1:${String(port)}`],
      allowedOrigins: [`http://127.0.0.1:${String(port)}`],
      secureDashboardCookie: false,
      serverVersion: "0.2.0",
      services: { ...base, identity, teachingConfiguration: teaching, skillAuthoring },
    }),
  close: () => {
    database.close();
  },
});
