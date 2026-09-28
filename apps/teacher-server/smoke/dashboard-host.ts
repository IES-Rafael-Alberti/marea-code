import {
  bundledDashboardProfileAuthority,
  bundledDashboardProfileRelease,
} from "../src/platform/teacher-host/bundled-profile-composition.js";
import { composeDashboardProfiles } from "../src/platform/teacher-host/profile-composition.js";
import { seedReleaseSession } from "./release-session.fixture.js";
import { seedReleaseUsage } from "./release-usage.fixture.js";
import { seedReleaseEvidence } from "./release-evidence.fixture.js";
/** Synthetic local host for real HTTP/browser acceptance; never opens an operator installation. */
import { cpSync } from "node:fs";
import { resolve, join } from "node:path";
import { createDashboardProfileStore, initializeSqliteStorage } from "@marea/sqlite-storage";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "../src/platform/teacher-host/teacher-host.fixture.js";
import {
  startTeacherHost,
  type TeacherHostOptions,
} from "../src/platform/teacher-host/teacher-host.js";
import { bunServe } from "../src/platform/teacher-host/bun-serve.boundary.js";

const fixture = teacherHostInstallation();
const legacy = process.argv.includes("--legacy");
const storage = initializeSqliteStorage({
  databasePath: fixture.databasePath,
  schema: legacy ? "retention-audit" : "dashboard-profiles",
});
storage.database.execute(
  "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:ready', 'ready', 'Synthetic Class')",
);
storage.database.execute(
  "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('user:second', 'second', 'hash:teacher-password', 'teacher', 'Second Teacher', NULL)",
);
for (const teacher of ["user:teacher", "user:second"])
  storage.database.execute("INSERT INTO marea_teacher_classes VALUES (?1, 'class:ready')", [
    teacher,
  ]);
storage.database.execute(
  "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:other', 'other', 'Other synthetic class')",
);
for (const teacher of ["user:teacher", "user:second"])
  storage.database.execute("INSERT INTO marea_teacher_classes VALUES (?1, 'class:other')", [
    teacher,
  ]);
seedReleaseSession(storage.database);
seedReleaseUsage(storage.database);
if (process.argv.includes("--evidence")) seedReleaseEvidence(storage.database);
if (process.argv.includes("--unavailable") || process.argv.includes("--future")) {
  createDashboardProfileStore(storage.database).write("user:teacher", "class:ready", {
    schemaVersion: process.argv.includes("--future") ? 2 : 1,
    revision: "synthetic:recoverable",
    updatedAt: "2026-09-22T00:00:00Z",
    serializedValue: JSON.stringify({
      themeId: "org.marea.removed-theme",
      modules: [
        {
          moduleId: "org.marea.removed-module",
          configurationVersion: 1,
          settings: {},
          enabled: true,
          placement: { slot: "main", size: "wide" },
        },
      ],
    }),
  });
}
storage.close();
cpSync(resolve("apps/dashboard/dist"), join(fixture.root, "dashboard"), { recursive: true });
fixture.writeHost({
  ...fixture.host,
  listen: { hostname: "127.0.0.1", port: 5196 },
  allowedHosts: ["127.0.0.1:5196"],
  allowedOrigins: ["http://127.0.0.1:5196"],
});
const options: TeacherHostOptions = {
  installationRoot: fixture.root,
  releaseId: "release:host",
  serve: bunServe,
  passwords: {
    hash: (value) => Promise.resolve(`hash:${value}`),
    verify: (value, hash) => Promise.resolve(hash === `hash:${value}`),
  },
  onEvaluationError: () => {
    throw new Error("Unexpected inference");
  },
};
let host = await startTeacherHost(options);
if (host.state !== "ready") throw new Error(host.reason);
console.log(JSON.stringify({ url: host.url, schema: legacy ? 9 : 10 }));
const stop = () => {
  if (host.state === "ready") void host.stop().then(cleanupTeacherHostInstallations);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

// Restart the actual host over the same synthetic installation; no public test endpoint.
process.on("SIGUSR2", () => {
  void (async () => {
    if (host.state !== "ready") throw new Error("Host unavailable before restart");
    await host.stop();
    host = await startTeacherHost(options);
    if (host.state !== "ready") throw new Error("Host unavailable after restart");
    console.log("restarted");
  })();
});

// Model a new generated server catalog while the already-loaded browser retains its old assets.
process.on("SIGUSR1", () => {
  void (async () => {
    if (host.state !== "ready") throw new Error("Host unavailable before catalog change");
    await host.stop();
    host = await startTeacherHost({
      ...options,
      profiles: (database) =>
        composeDashboardProfiles({
          database,
          release: { ...bundledDashboardProfileRelease(), revision: "a".repeat(64) },
          authority: bundledDashboardProfileAuthority,
          clock: { now: () => new Date().toISOString() },
          ids: { createId: () => crypto.randomUUID() },
          currentCatalogRevision: () => "a".repeat(64),
        }),
    });
    if (host.state !== "ready") throw new Error("Host unavailable after catalog change");
    console.log("catalog-changed");
  })();
});
