import { syntheticHostPost } from "./synthetic-host-http.fixture.js";
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { createDashboardProfileStore, initializeSqliteStorage } from "@marea/sqlite-storage";
import {
  bundledDashboardProfileAuthority,
  bundledDashboardProfileRelease,
} from "../src/platform/teacher-host/bundled-profile-composition.js";
import { composeDashboardProfiles } from "../src/platform/teacher-host/profile-composition.js";
import {
  validateDashboardProfileRelease,
  type DashboardReleaseDiagnostic,
} from "../src/dashboard-profiles/release.js";
import { startTeacherHost } from "../src/platform/teacher-host/teacher-host.js";
import { bunServe } from "../src/platform/teacher-host/bun-serve.boundary.js";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "../src/platform/teacher-host/teacher-host.fixture.js";

const original = bundledDashboardProfileRelease();
const module = original.modules[0];
const fallback = original.themes.find((theme) => theme.id === original.defaults.themeId);
assert.ok(module);
assert.ok(fallback);
const scenarios = [
  { name: "optional-absent", release: { ...original, modules: [], themes: [fallback] } },
  {
    name: "optional-invalid",
    release: { ...original, modules: [{ ...module, configurationVersion: 0 }], themes: [fallback] },
  },
  { name: "future-profile", release: original, version: 2 },
  { name: "malformed-profile", release: original, serialized: "{" },
  { name: "catalog-changed", release: { ...original, revision: "a".repeat(64) } },
  {
    name: "required-absent",
    release: { ...original, themes: [] },
    diagnostic: /org.marea.theme.marea: required artifact missing/,
    reason: "required-missing",
  },
  {
    name: "required-invalid",
    release: { ...original, themes: [{ ...fallback, configurationVersion: 0 }] },
    diagnostic: /org.marea.theme.marea: required artifact missing/,
    reason: "required-missing",
  },
  {
    name: "required-dependency",
    release: {
      ...original,
      themes: [{ ...fallback, requiredDependencies: ["org.marea.missing"] }],
    },
    diagnostic: /required dependency or capability unavailable/,
    reason: "required-unavailable",
  },
  {
    name: "dependency-cycle",
    release: {
      ...original,
      themes: [{ ...fallback, requiredDependencies: [module.id] }],
      modules: [{ ...module, requiredDependencies: [fallback.id] }],
    },
    diagnostic: /dependency cycle/,
    reason: "dependency-cycle",
  },
];
try {
  for (const scenario of scenarios) {
    const f = teacherHostInstallation();
    cpSync(resolve("apps/dashboard/dist"), f.host.dashboardDistPath, { recursive: true });
    f.writeHost({ ...f.host, allowedHosts: ["127.0.0.1"], allowedOrigins: ["http://127.0.0.1"] });
    const storage = initializeSqliteStorage({
      databasePath: f.databasePath,
      schema: "dashboard-profiles",
    });
    const stored = {
      schemaVersion: scenario.version ?? 1,
      revision: "synthetic:saved",
      updatedAt: "2026-09-22T00:00:00Z",
      serializedValue:
        scenario.serialized ??
        JSON.stringify({ ...original.defaults, themeId: "org.marea.theme.high-contrast" }),
    };
    createDashboardProfileStore(storage.database).write("user:teacher", null, stored);
    storage.close();
    if (scenario.diagnostic) {
      assert.throws(() => validateDashboardProfileRelease(scenario.release), scenario.diagnostic);
      assert.throws(
        () => validateDashboardProfileRelease(scenario.release),
        /Rebuild or enable compatible release artifacts/,
      );
    }
    let listens = 0;
    const diagnostics: DashboardReleaseDiagnostic[] = [];
    const host = await startTeacherHost({
      installationRoot: f.root,
      releaseId: "release:host",
      serve: (options) => {
        listens++;
        return bunServe(options);
      },
      passwords: {
        hash: (value) => Promise.resolve(`hash:${value}`),
        verify: (value, hash) => Promise.resolve(hash === `hash:${value}`),
      },
      onStartupDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      onEvaluationError: () => {
        throw new Error("Unexpected synthetic evaluation");
      },
      profiles: (database) =>
        composeDashboardProfiles({
          database,
          release: scenario.release,
          authority: bundledDashboardProfileAuthority,
          clock: { now: () => "2026-09-22T00:00:00Z" },
          ids: { createId: () => "synthetic:next" },
          currentCatalogRevision: () => scenario.release.revision,
        }),
    });
    try {
      if (scenario.diagnostic) {
        assert.deepEqual(host, { state: "failed", reason: "config" });
        assert.equal(listens, 0);
        assert.equal(diagnostics.length, 1);
        const [diagnostic] = diagnostics;
        if (diagnostic === undefined) throw new Error("Missing private startup diagnostic");
        assert.ok(diagnostic.pluginId.startsWith("org.marea."));
        assert.deepEqual(diagnostic, {
          kind: "dashboard-release",
          pluginId: diagnostic.pluginId,
          reason: scenario.reason,
          remedy: "rebuild-compatible-release",
        });
      } else {
        assert.equal(host.state, "ready");
        assert.deepEqual(diagnostics, []);
        const send = syntheticHostPost(host.url);
        const post = (path: string, body: object, cookie = "") =>
          send(path, { protocolVersion: "0.1", requestId: "synthetic:request", ...body }, cookie);
        const login = await post("/v1/auth/login", {
          kind: "credential-login",
          credentials: { login: "teacher", password: "teacher-password" },
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get("set-cookie")?.split(";")[0];
        assert.ok(cookie);
        const response = await post(
          "/api/v1/dashboard/profiles/read",
          { kind: "dashboard-profile-read", scope: { kind: "teacher" } },
          cookie,
        );
        assert.equal(response.status, 200);
        const state = validateDashboardProfileRelease(scenario.release).schemas.state.parse(
          await response.json(),
        );
        if (scenario.name.startsWith("optional")) {
          assert.equal(state.effective.themeId, fallback.id);
          assert.deepEqual(state.effective.modules, []);
          assert.ok(state.warnings.length >= 2);
        }
        if (scenario.version || scenario.serialized)
          assert.equal(state.personal.status, "recovery-required");
        const save = await post(
          "/api/v1/dashboard/profiles/save",
          {
            kind: "dashboard-profile-save",
            scope: { kind: "teacher" },
            expectedRevision: stored.revision,
            expectedPersonalRevision: stored.revision,
            catalogRevision: original.revision,
            discardUnavailable: false,
            value: original.defaults,
          },
          cookie,
        );
        if (scenario.name === "catalog-changed" || scenario.version || scenario.serialized)
          assert.equal(save.status, 409);
        assert.equal((await fetch(`${host.url}/dashboard/`)).status, 200);
      }
    } finally {
      if (host.state === "ready") await host.stop();
    }
    const reopened = initializeSqliteStorage({
      databasePath: f.databasePath,
      schema: "dashboard-profiles",
    });
    assert.deepEqual(
      createDashboardProfileStore(reopened.database).read("user:teacher", null),
      stored,
    );
    reopened.close();
    console.log(
      `${scenario.name}: compiled host readiness/recovery and unchanged stored profile passed`,
    );
  }
} finally {
  cleanupTeacherHostInstallations();
}
