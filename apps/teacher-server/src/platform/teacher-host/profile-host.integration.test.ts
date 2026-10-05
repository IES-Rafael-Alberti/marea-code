import { validateDashboardProfileRelease } from "../../dashboard-profiles/release.js";
import {
  createOperatorCliApplication,
  readOperatorCliConfig,
} from "../operator-cli/composition.js";
import { syntheticProfileHostServices } from "./profile-host-options.fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { createOperationsApplication } from "../operations-cli/operations-application.js";
import { readOperationsConfig } from "../operations-cli/operations-config.js";
import { readInstallationStatus } from "../operations-cli/installation-status.js";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
import {
  initializeSqliteStorage,
  restoreSqliteBackup,
  createDashboardProfileStore,
} from "@marea/sqlite-storage";
import { join } from "node:path";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "./teacher-host.fixture.js";
import { startTeacherHost, type TeacherHostOptions } from "./teacher-host.js";
import { release, schemas } from "../../dashboard-profiles/release.fixture.js";
import { profileRetentionRows } from "../operations/retention/profile-retention.js";
import { removeRemainingRetentionContent } from "../operations/retention/retention-content.js";
afterEach(cleanupTeacherHostInstallations);
it.each([
  ["dashboard-profiles", 10],
  ["educational-insights", 11],
  ["student-identities", 12],
] as const)(
  "starts the production host on %s, authenticates, persists, reopens and restores profiles",
  async (schema, version) => {
    const f = teacherHostInstallation();
    const upgraded = initializeSqliteStorage({
      databasePath: f.databasePath,
      schema,
    });
    expect(upgraded.schema.version).toBe(version);
    upgraded.close();
    const host = await startTeacherHost({
      installationRoot: f.root,
      releaseId: "release:host",
      serve: f.serve,
      ...syntheticProfileHostServices(() => "profile-host-revision"),
    });
    expect(host.state).toBe("ready");
    if (host.state !== "ready" || f.served.fetch === undefined) throw new Error("Host not ready");
    const fetch = f.served.fetch;
    const post = (path: string, body: object, cookie = "") =>
      fetch(
        new Request(`http://teacher.test${path}`, {
          method: "POST",
          headers: {
            host: "teacher.test",
            origin: "https://dashboard.test",
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const login = await post("/v1/auth/login", {
      protocolVersion: "0.1",
      requestId: "login-request",
      kind: "credential-login",
      credentials: { login: "teacher", password: "teacher-password" },
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("No cookie");
    const saved = await post(
      "/api/v1/dashboard/profiles/save",
      {
        protocolVersion: "0.1",
        requestId: "save-request",
        kind: "dashboard-profile-save",
        scope: { kind: "teacher" },
        expectedRevision: null,
        expectedPersonalRevision: null,
        catalogRevision: release.revision,
        discardUnavailable: false,
        value: release.defaults,
      },
      cookie,
    );
    expect(saved.status).toBe(200);
    expect(schemas.state.parse(await saved.json()).personal.revision).toBe("profile-host-revision");
    await host.stop();
    const reopened = initializeSqliteStorage({
      databasePath: f.databasePath,
      schema,
    });
    const store = createDashboardProfileStore(reopened.database);
    expect(store.read("user:teacher", null)?.revision).toBe("profile-host-revision");
    expect(profileRetentionRows(reopened.database)).toHaveLength(1);
    const backup = reopened.createBackup();
    expect(backup.schemaVersion).toBe(version);
    reopened.close();
    const restored = restoreSqliteBackup({
      databasePath: join(f.root, "restored.sqlite"),
      schema,
      backup,
    });
    expect(
      createDashboardProfileStore(restored.database).read("user:teacher", null)?.serializedValue,
    ).toBe(JSON.stringify(release.defaults));
    restored.database.execute("DELETE FROM marea_auth_sessions");
    expect(
      removeRemainingRetentionContent(restored.database, {
        accountIds: ["user:teacher"],
        runIds: [],
        snapshotIds: [],
      }),
    ).toBe(2);
    expect(createDashboardProfileStore(restored.database).read("user:teacher", null)).toBeNull();
    restored.close();
    expect(() =>
      initializeSqliteStorage({ databasePath: f.databasePath, schema: "retention-audit" }),
    ).toThrow();
  },
);

it.each([
  ["dashboard-profiles", 10],
  ["educational-insights", 11],
  ["student-identities", 12],
] as const)(
  "includes %s in the authorized operations backup and restore workflow",
  async (schema, version) => {
    const f = teacherHostInstallation();
    const storage = initializeSqliteStorage({
      databasePath: f.databasePath,
      schema,
    });
    createDashboardProfileStore(storage.database).write("user:teacher", null, {
      schemaVersion: 1,
      revision: "backup-revision",
      updatedAt: "2026-09-22T12:00:00Z",
      serializedValue: JSON.stringify(release.defaults),
    });
    storage.close();
    const owned = acquireInstallation(f.root);
    const operations = createOperationsApplication(
      owned.capability,
      readOperationsConfig(f.root),
      () => "2026-09-22T12:00:00Z",
    );
    try {
      expect(operations.activate().schemaVersion).toBe(version);
      const backup = await operations.createBackup("profiles-backup");
      const destinationParent = realpathSync(mkdtempSync(join(tmpdir(), "marea-profile-restore-")));
      const destination = join(destinationParent, "restored");
      try {
        const result = await operations.restore({
          bundlePath: backup.path,
          destinationRoot: destination,
        });
        expect(result).toMatchObject({ state: "restored", schemaVersion: version });
        const restored = initializeSqliteStorage({
          databasePath: join(destination, "database.sqlite"),
          schema,
        });
        expect(
          createDashboardProfileStore(restored.database).read("user:teacher", null)?.revision,
        ).toBe("backup-revision");
        restored.close();
      } finally {
        rmSync(destinationParent, { recursive: true, force: true });
      }
    } finally {
      operations.close();
      owned.release();
    }
    const operatorOwnership = acquireInstallation(f.root);
    try {
      const operator = createOperatorCliApplication(
        operatorOwnership.capability,
        readOperatorCliConfig(f.root),
      );
      operator.close();
    } finally {
      operatorOwnership.release();
    }
    expect(await readInstallationStatus(f.root)).toMatchObject({
      schemaVersion: version,
      supportedSchemaVersion: version,
      upgrade: "none",
    });
  },
);
function missingRelease(): never {
  validateDashboardProfileRelease({ ...release, themes: [] });
  throw new Error("Invalid release was accepted");
}
it("fails readiness before listening when a required dashboard release is missing", async () => {
  const f = teacherHostInstallation();
  initializeSqliteStorage({ databasePath: f.databasePath, schema: "dashboard-profiles" }).close();
  const diagnostics: unknown[] = [];
  const failing = (profiles: TeacherHostOptions["profiles"], sink = diagnostics) =>
    startTeacherHost({
      installationRoot: f.root,
      releaseId: "release:host",
      serve: f.serve,
      ...syntheticProfileHostServices(() => "unused"),
      profiles,
      onStartupDiagnostic: (diagnostic) => {
        sink.push(diagnostic);
      },
    });
  expect(await failing(missingRelease)).toEqual({ state: "failed", reason: "config" });
  expect(f.served.fetch).toBeUndefined();
  expect(diagnostics).toEqual([
    {
      kind: "dashboard-release",
      pluginId: release.defaults.themeId,
      reason: "required-missing",
      remedy: "rebuild-compatible-release",
    },
  ]);
  const module = release.modules[0];
  const cycle = () => {
    validateDashboardProfileRelease({
      ...release,
      modules: [{ ...module, requiredDependencies: [release.defaults.themeId] }],
      themes: release.themes.map((theme) => ({ ...theme, requiredDependencies: [module.id] })),
    });
    throw new Error("Invalid release was accepted");
  };
  expect(await failing(cycle)).toEqual({ state: "failed", reason: "config" });
  expect(diagnostics.at(-1)).toMatchObject({ reason: "dependency-cycle" });
  // Arbitrary caught text never reaches the private sink.
  expect(
    await failing(() => {
      throw new Error("/private/credential secret");
    }),
  ).toEqual({ state: "failed", reason: "config" });
  expect(diagnostics).toHaveLength(2);
});
it("releases ownership and keeps the public failure when the private sink throws", async () => {
  const f = teacherHostInstallation();
  initializeSqliteStorage({ databasePath: f.databasePath, schema: "dashboard-profiles" }).close();
  const sink = vi.fn(() => {
    throw new Error("sink unavailable");
  });
  const unobserved = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    ...syntheticProfileHostServices(() => "unused"),
    profiles: missingRelease,
  });
  expect(unobserved).toEqual({ state: "failed", reason: "config" });
  const host = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    ...syntheticProfileHostServices(() => "unused"),
    profiles: () => {
      validateDashboardProfileRelease({ ...release, requiredIds: ["org.marea.absent"] });
      throw new Error("Invalid release was accepted");
    },
    onStartupDiagnostic: sink,
  });
  expect(host).toEqual({ state: "failed", reason: "config" });
  expect(sink).toHaveBeenCalledExactlyOnceWith({
    kind: "dashboard-release",
    pluginId: "org.marea.absent",
    reason: "required-missing",
    remedy: "rebuild-compatible-release",
  });
  expect(f.served.fetch).toBeUndefined();
  acquireInstallation(f.root).release();
});
