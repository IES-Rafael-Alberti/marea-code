import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { initializeSqliteStorage } from "@marea/sqlite-storage";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "../src/platform/teacher-host/teacher-host.fixture.js";
import { startTeacherHost } from "../src/platform/teacher-host/teacher-host.js";
import { bunServe } from "../src/platform/teacher-host/bun-serve.boundary.js";
import { teachingConfiguration } from "../test-support/teaching-fixture.js";
import { replaceTeachingSkills } from "../src/teaching/configuration/replace-skills.js";
import { SqliteTeachingConfigurationRepository } from "../src/platform/persistence/sqlite-teaching-configuration-repository.js";

/** Disposable real host for the skill UX browser journey; no external models or real pupils. */
const f = teacherHostInstallation();
f.writeHost({
  ...f.host,
  listen: { hostname: "127.0.0.1", port: 5198 },
  allowedHosts: ["127.0.0.1:5198"],
  allowedOrigins: ["http://127.0.0.1:5198"],
});
const storage = initializeSqliteStorage({
  databasePath: f.databasePath,
  schema: "skill-assignments",
});
storage.database.execute(
  "INSERT INTO marea_classes VALUES ('class:ready', 'ready', 'Clase de prueba')",
);
storage.database.execute(
  "INSERT INTO marea_teacher_classes VALUES ('user:teacher', 'class:ready')",
);
storage.database.execute(
  "INSERT INTO marea_users VALUES ('student:ana','ana','hash:password','student','Ana','class:ready'),('student:pablo','pablo','hash:password','student','Pablo','class:ready')",
);
new SqliteTeachingConfigurationRepository(storage.database).saveRevision({
  classId: "class:ready",
  teacherId: "user:teacher",
  expectedVersion: null,
  createdAt: new Date().toISOString(),
  configuration: replaceTeachingSkills(teachingConfiguration(), [], [], "revision:start"),
});
storage.close();
mkdirSync(join(f.root, "core/didactic/testing"), { mode: 0o700 });
writeFileSync(
  join(f.root, "core/didactic/testing/SKILL.md"),
  "---\nname: testing\ndescription: Aprender a escribir pruebas pequeñas y útiles.\n---\n# Testing\n\nPropón al alumno un caso de prueba pequeño para su proyecto.\n",
  { mode: 0o600 },
);
rmSync(join(f.root, "dashboard"), { recursive: true });
cpSync(
  resolve(process.env.MAREA_DASHBOARD_DIST ?? "apps/dashboard/dist"),
  join(f.root, "dashboard"),
  { recursive: true },
);
function protect(path: string) {
  const directory = statSync(path).isDirectory();
  chmodSync(path, directory ? 0o700 : 0o600);
  if (directory) for (const name of readdirSync(path)) protect(join(path, name));
}
protect(join(f.root, "dashboard"));
const host = await startTeacherHost({
  installationRoot: f.root,
  releaseId: "release:host",
  serve: bunServe,
  onEvaluationError: () => {
    console.error("Synthetic evaluation failed");
  },
  passwords: {
    hash: (value) => Promise.resolve(`hash:${value}`),
    verify: (value, hash) => Promise.resolve(hash === `hash:${value}`),
  },
});
if (host.state !== "ready") throw new Error("Synthetic skill host failed");
console.log(`SKILL_WORKSPACE_URL=${host.url}/dashboard/index.html`);
const stop = async () => {
  await host.stop();
  cleanupTeacherHostInstallations();
  process.exit(0);
};
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
