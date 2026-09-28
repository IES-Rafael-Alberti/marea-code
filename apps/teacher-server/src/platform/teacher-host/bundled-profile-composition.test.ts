import * as z from "zod";
import {
  defineDashboardModuleCatalogEntry,
  type DashboardModuleCatalogEntry,
} from "@marea/plugin-api";
const discovered = vi.hoisted(() => ({
  modules: [] as DashboardModuleCatalogEntry[],
  generated: 0,
}));
vi.mock("@marea/plugin-runtime", async (original) => {
  const runtime = await original<typeof import("@marea/plugin-runtime")>();
  discovered.modules.push(...runtime.dashboardModuleCatalog);
  discovered.generated = runtime.dashboardModuleCatalog.length;
  return { ...runtime, dashboardModuleCatalog: discovered.modules };
});
import { request } from "../../product-http/product-http.fixture.js";
import { captured } from "./captured.js";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
import { initializeSqliteStorage, inspectSqliteSchemaVersion } from "@marea/sqlite-storage";
import { dashboardCatalogRevision } from "@marea/plugin-runtime";
import { TelemetryPreviewResponseSchema } from "@marea/protocol";
import {
  bundledDashboardProfileAuthority,
  bundledDashboardProfileRelease,
} from "./bundled-profile-composition.js";
import { validateDashboardProfileRelease } from "../../dashboard-profiles/release.js";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "./teacher-host.fixture.js";
import { startTeacherHost } from "./teacher-host.js";

afterEach(() => {
  cleanupTeacherHostInstallations();
  discovered.modules.splice(discovered.generated);
});

it("binds the actual generated release, strict settings and only implemented permissions", () => {
  const release = bundledDashboardProfileRelease();
  const valid = validateDashboardProfileRelease(release);
  expect(release.revision).toBe(dashboardCatalogRevision);
  expect(release.requiredIds).toEqual(["org.marea.theme.marea"]);
  expect(release.capabilities).toEqual([
    "sessions/v1",
    "usage/v1",
    "health/v1",
    "reviewed-evidence/v1",
  ]);
  const selected = (moduleId: string, slot: "main" | "aside", size: "standard" | "wide") => ({
    moduleId,
    configurationVersion: 1,
    enabled: true,
    placement: { slot, size },
    settings: {},
  });
  expect(valid.defaults).toEqual({
    themeId: "org.marea.theme.marea",
    modules: [
      selected("org.marea.module.health", "aside", "standard"),
      { ...selected("org.marea.module.reviewed-evidence", "aside", "standard"), enabled: false },
      selected("org.marea.module.sessions", "main", "wide"),
      selected("org.marea.module.usage", "aside", "standard"),
    ],
  });
  expect(valid.modules.map((module) => [module.id, module.requiredPermissions])).toEqual([
    ["org.marea.module.health", ["class-read", "health-read"]],
    ["org.marea.module.reviewed-evidence", ["class-read", "evaluation-read"]],
    ["org.marea.module.sessions", ["class-read", "session-read"]],
    ["org.marea.module.usage", ["class-read", "usage-read"]],
  ]);
  expect(valid.modules[0]).not.toHaveProperty("entrypoint");
  expect(valid.modules[0]).not.toHaveProperty("browserEntrypoint");
  expect(valid.themes.map((theme) => theme.id)).toEqual([
    "org.marea.theme.high-contrast",
    "org.marea.theme.marea",
  ]);
  expect(valid.themes.every((theme) => !("entrypoint" in theme))).toBe(true);
  expect(
    release.selection.safeParse({ ...valid.defaults.modules[0], settings: { forged: true } })
      .success,
  ).toBe(false);
  const module = captured(release.modules[0]);
  const teacher = {
    userId: "teacher",
    displayName: "Teacher",
    role: "teacher" as const,
    classId: null,
  };
  const scope = { kind: "teacher" as const };
  expect(bundledDashboardProfileAuthority.permits(teacher, scope, module)).toBe(true);
  expect(
    bundledDashboardProfileAuthority.permits({ ...teacher, role: "student" }, scope, module),
  ).toBe(false);
  for (const requiredPermissions of [
    ["class-read", "evaluation-read"],
    ["class-read", "usage-read"],
    ["class-read", "health-read"],
  ] as const)
    expect(
      bundledDashboardProfileAuthority.permits(teacher, scope, {
        ...module,
        requiredPermissions: [...requiredPermissions],
      }),
    ).toBe(true);
  for (const permission of ["evaluation-review"] as const)
    expect(
      bundledDashboardProfileAuthority.permits(teacher, scope, {
        ...module,
        requiredPermissions: ["class-read", permission],
      }),
    ).toBe(false);
});

it.each([false, true])(
  "composes production profiles only on upgraded storage (%s), retaining preview and legacy access",
  async (upgraded) => {
    const f = teacherHostInstallation();
    const storage = initializeSqliteStorage({
      databasePath: f.databasePath,
      schema: upgraded ? "dashboard-profiles" : "retention-audit",
    });
    storage.database.execute(
      "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:ready', 'ready', 'Class Ready')",
    );
    storage.database.execute(
      "INSERT INTO marea_teacher_classes VALUES ('user:teacher', 'class:ready')",
    );
    storage.close();
    const host = await startTeacherHost({
      installationRoot: f.root,
      releaseId: "release:host",
      serve: f.serve,
      passwords: {
        hash: (value) => Promise.resolve(`hash:${value}`),
        verify: (value, hash) => Promise.resolve(hash === `hash:${value}`),
      },
      onEvaluationError: () => undefined,
    });
    if (host.state !== "ready") throw new Error(host.reason);
    try {
      const post = (path: string, body: object, cookie = "") =>
        captured(f.served.fetch)(
          request(path, body, undefined, { origin: "https://dashboard.test", cookie }),
        );
      const login = await post("/v1/auth/login", {
        protocolVersion: "0.1",
        requestId: "login",
        kind: "credential-login",
        credentials: { login: "teacher", password: "teacher-password" },
      });
      expect(login.status).toBe(200);
      const cookie = captured(String(login.headers.get("set-cookie")).split(";")[0]);
      const envelope = {
        protocolVersion: "0.1",
        requestId: "profile",
        scope: { kind: "class", classId: "class:ready" },
      };
      const read = await post(
        "/api/v1/dashboard/profiles/read",
        { ...envelope, kind: "dashboard-profile-read" },
        cookie,
      );
      expect(read.status).toBe(upgraded ? 200 : 503);
      expect(inspectSqliteSchemaVersion({ databasePath: f.databasePath })).toBe(upgraded ? 10 : 9);
      if (upgraded) {
        const release = validateDashboardProfileRelease(bundledDashboardProfileRelease());
        const state = release.schemas.state.parse(await read.json());
        expect(state.effective).toEqual({
          ...release.defaults,
          modules: release.defaults.modules.filter((module) => module.enabled),
        });
        const value = { themeId: "org.marea.theme.high-contrast", modules: [] };
        const save = {
          ...envelope,
          kind: "dashboard-profile-save",
          expectedRevision: null,
          expectedPersonalRevision: null,
          catalogRevision: release.revision,
          discardUnavailable: false,
          value,
        };
        const saved = await post("/api/v1/dashboard/profiles/save", save, cookie);
        expect(saved.status).toBe(200);
        const after = release.schemas.state.parse(await saved.json());
        expect(after.override?.value).toEqual(value);
        expect(after.override?.revision).not.toBeNull();
        expect(Date.parse(after.generatedAt)).toBeGreaterThan(0);
        expect((await post("/api/v1/dashboard/profiles/save", save, cookie)).status).toBe(409);
        const catalog = await post(
          "/api/v1/dashboard/profiles/catalog",
          { ...envelope, kind: "dashboard-profile-catalog" },
          cookie,
        );
        expect(release.catalogSchema.parse(await catalog.json()).modules).toEqual(release.modules);
      } else {
        expect(read.headers.get("x-marea-profile-mode")).toBe("legacy");
      }
      const preview = await post(
        "/api/v1/dashboard/telemetry/preview",
        {
          protocolVersion: "0.1",
          requestId: "preview",
          kind: "telemetry-preview",
          classId: "class:ready",
        },
        cookie,
      );
      expect(preview.status).toBe(200);
      expect(TelemetryPreviewResponseSchema.parse(await preview.json())).toMatchObject({
        enabled: false,
        destinationCount: 0,
        synthetic: true,
      });
    } finally {
      await host.stop();
    }
  },
);

it("requires an offline profile upgrade when an explicit profile factory is supplied", async () => {
  const f = teacherHostInstallation();
  const profiles = vi.fn(() => {
    throw new Error("Must not compose on schema 9");
  });
  const host = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    profiles,
    passwords: { hash: (value) => Promise.resolve(value), verify: () => Promise.resolve(false) },
    onEvaluationError: () => undefined,
  });
  expect(host).toEqual({ state: "failed", reason: "config" });
  expect(profiles).not.toHaveBeenCalled();
  expect(f.served.fetch).toBeUndefined();
  expect(inspectSqliteSchemaVersion({ databasePath: f.databasePath })).toBe(9);
});

it("uses each discovered plugin validator and normalized defaults, including nonempty settings", () => {
  const first = captured(discovered.modules[0]);
  discovered.modules.push(
    defineDashboardModuleCatalogEntry({
      manifest: { ...first.manifest, id: "org.marea.configurable" },
      settingsSchema: z.strictObject({ limit: z.number().int().min(1).max(10) }),
      defaultSettings: { limit: 5 },
    }),
  );
  const release = bundledDashboardProfileRelease();
  const selection = captured(release.defaults.modules.at(-1));
  expect(selection.settings).toEqual({ limit: 5 });
  expect(release.selection.parse(selection)).toEqual(selection);
  expect(release.selection.safeParse({ ...selection, settings: {} }).success).toBe(false);
  expect(release.selection.safeParse({ ...selection, settings: { limit: 11 } }).success).toBe(
    false,
  );
  expect(
    release.selection.safeParse({ ...selection, settings: { limit: 5, extra: true } }).success,
  ).toBe(false);
});
