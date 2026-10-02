import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "./teacher-host.fixture.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { createOperationsApplication } from "../operations-cli/operations-application.js";
import { readOperationsConfig } from "../operations-cli/operations-config.js";
import { serverSettingsStore } from "./server-settings-store.boundary.js";
import { commitServerSettings, prepareServerSettings } from "./initialize-server-settings.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import { USAGE_POLICY } from "../../../test-support/usage-fixture.js";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
afterEach(cleanupTeacherHostInstallations);
it("explicitly grants the existing teacher server ownership without changing host configuration", async () => {
  const f = teacherHostInstallation();
  const path = join(f.root, "config", "teacher-host.json");
  const before = readFileSync(path, "utf8");
  const owned = acquireInstallation(f.root);
  const config = readOperationsConfig(f.root);
  const app = createOperationsApplication(owned.capability, config, () => "2026-10-02T12:00:00Z");
  try {
    await expect(app.initializeServerSettings("user:missing", "before-missing")).rejects.toEqual(
      new OperatorCliError("invalid-input"),
    );
    expect(serverSettingsStore(f.root).read()).toBeNull();
    // A refused grant is validated before the safety backup, so it leaves no orphaned bundle.
    expect(existsSync(join(config.backupRoot, "before-missing"))).toBe(false);
    expect(await app.initializeServerSettings("user:teacher", "before-settings")).toEqual({
      administrator: "user:teacher",
      revision: 0,
    });
    expect(serverSettingsStore(f.root).read()).toMatchObject({
      administrators: ["user:teacher"],
      useCommonRoute: false,
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(config.backupRoot, "before-settings"))).toBe(true);
    await expect(app.initializeServerSettings("user:teacher", "before-repeat")).rejects.toEqual(
      new TeacherDomainError("request.conflict"),
    );
    expect(existsSync(join(config.backupRoot, "before-repeat"))).toBe(false);
    // Later operational backups carry the private settings file inside a private directory.
    await app.createBackup("after-settings");
    const copied = join(config.backupRoot, "after-settings", "config");
    expect(statSync(copied).mode & 0o777).toBe(0o700);
    expect(statSync(join(copied, "server-settings.json")).mode & 0o777).toBe(0o600);
  } finally {
    app.close();
    owned.release();
  }
});

it("imports endpoints and educational routes, and starts without a common route when no class exists", async () => {
  const f = teacherHostInstallation({ readyClasses: [] });
  const credentialPath = join(f.root, "state", "provider.key");
  writeFileSync(credentialPath, "synthetic-imported-key\n", { mode: 0o600 });
  const educationalInsights = {
    map: {
      providerId: "org.marea.openrouter",
      model: "synthetic-map-model",
      budget: USAGE_POLICY,
      inputTokenCeiling: USAGE_POLICY.maxInputTokens,
    },
  };
  f.writeHost({
    ...f.host,
    providers: [
      {
        pluginId: "org.marea.openrouter",
        credentialPath,
        endpoint: "https://provider.example.test/v1/chat/completions",
      },
      { pluginId: "org.marea.other", credentialPath },
    ],
    educationalInsights,
  });
  const owned = acquireInstallation(f.root);
  const app = createOperationsApplication(
    owned.capability,
    readOperationsConfig(f.root),
    () => "2026-10-02T12:00:00Z",
  );
  try {
    await app.initializeServerSettings("user:teacher", "before-settings");
    expect(serverSettingsStore(f.root).read()).toMatchObject({
      connections: {
        "org.marea.openrouter": {
          apiKey: "synthetic-imported-key",
          endpoint: "https://provider.example.test/v1/chat/completions",
        },
        "org.marea.other": { apiKey: "synthetic-imported-key" },
      },
      route: null,
      legacyRoutes: [],
      education: educationalInsights,
    });
  } finally {
    app.close();
    owned.release();
  }
});

it("requires the installation lock to prepare and to commit", () => {
  const f = teacherHostInstallation();
  const lost = {
    installationRoot: f.root,
    assertOwned: () => {
      throw new OperatorCliError("installation-lost");
    },
  } as unknown as Parameters<typeof prepareServerSettings>[0];
  const readOne = vi.fn();
  const database = { readOne } as unknown as Parameters<typeof prepareServerSettings>[1];
  expect(() => prepareServerSettings(lost, database, "user:teacher")).toThrow(OperatorCliError);
  expect(readOne).not.toHaveBeenCalled();
  expect(() =>
    commitServerSettings(lost, {} as Parameters<typeof commitServerSettings>[1]),
  ).toThrow(OperatorCliError);
  expect(serverSettingsStore(f.root).read()).toBeNull();
});
