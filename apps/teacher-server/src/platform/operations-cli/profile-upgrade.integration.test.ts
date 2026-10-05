import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initializeSqliteStorage, inspectSqliteSchemaVersion } from "@marea/sqlite-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeOpens } from "../operator-cli/bun-sqlite.fixture.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { cleanupTeacherHostInstallations } from "../teacher-host/teacher-host.fixture.js";
import { createOperationsApplication } from "./operations-application.js";
import { readOperationsConfig } from "./operations-config.js";
import { readInstallationStatus } from "./installation-status.js";
import { profileUpgradeInstallation } from "./profile-upgrade.fixture.js";
import { profileReleaseReadiness } from "./profile-release-readiness.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
afterEach(() => {
  expect(nativeOpens.filter((entry) => !entry.closed)).toEqual([]);
  cleanupTeacherHostInstallations();
});
const now = () => "2026-09-22T12:00:00.000Z";

function open(f: ReturnType<typeof profileUpgradeInstallation>, fail?: "backed-up" | "migrated") {
  const owned = acquireInstallation(f.root);
  const app = createOperationsApplication(owned.capability, readOperationsConfig(f.root), now, {
    acquire: acquireInstallation,
    read: readOperationsConfig,
    ...(fail === undefined
      ? {}
      : {
          profileUpgradeDurable: (step: "backed-up" | "migrated") => {
            if (step === fail) throw new Error("interrupted");
          },
        }),
  });
  return {
    app,
    close: () => {
      app.close();
      owned.release();
    },
  };
}

describe("explicit offline profile upgrade", () => {
  it("backs up before migration, keeps legacy activation and reports restart/rollback remedies", async () => {
    const f = profileUpgradeInstallation();
    const owned = open(f);
    try {
      expect(owned.app.activate()).toEqual({ schemaVersion: 9 });
      expect(await readInstallationStatus(f.root)).toMatchObject({
        profileUpgrade: {
          state: "available-offline",
          command: "installation upgrade-profiles --input <private-json-with-new-backup-name>",
          release: { ready: true },
          rollback: expect.stringContaining("current deletion index") as unknown,
          recovery: expect.stringContaining("schema 12 is committed") as unknown,
        },
      });
      expect(await owned.app.upgradeProfiles("before-profiles")).toEqual({
        schemaVersion: 12,
        backupPath: join(f.root, "backups", "before-profiles"),
      });
      expect(
        inspectSqliteSchemaVersion({
          databasePath: join(f.root, "backups", "before-profiles", "database.sqlite"),
        }),
      ).toBe(9);
      expect(await owned.app.createBackup("after-profiles")).toMatchObject({
        path: join(f.root, "backups", "after-profiles"),
      });
      await expect(owned.app.upgradeProfiles("repeat")).rejects.toMatchObject({
        code: "request.conflict",
      });
      expect(existsSync(join(f.root, "backups", "repeat"))).toBe(false);
    } finally {
      owned.close();
    }
    const restarted = open(f);
    try {
      expect(restarted.app.activate()).toEqual({ schemaVersion: 12 });
      expect(await readInstallationStatus(f.root)).toMatchObject({
        profileUpgrade: { state: "active" },
      });
    } finally {
      restarted.close();
    }
  });

  it("upgrades an educational schema 11 installation to student identities", async () => {
    const f = profileUpgradeInstallation();
    const owned = open(f);
    try {
      expect(owned.app.activate()).toEqual({ schemaVersion: 9 });
    } finally {
      owned.close();
    }
    initializeSqliteStorage({
      databasePath: f.databasePath,
      schema: "educational-insights",
    }).close();
    const educational = open(f);
    try {
      expect(educational.app.activate()).toEqual({ schemaVersion: 11 });
      expect(await educational.app.upgradeProfiles("before-identities")).toMatchObject({
        schemaVersion: 12,
      });
      expect(
        inspectSqliteSchemaVersion({
          databasePath: join(f.root, "backups", "before-identities", "database.sqlite"),
        }),
      ).toBe(11);
    } finally {
      educational.close();
    }
  });

  it.each(["backed-up", "migrated"] as const)(
    "recovers interruption after %s without replacing the prior backup",
    async (step) => {
      const f = profileUpgradeInstallation();
      const owned = open(f, step);
      try {
        await expect(owned.app.upgradeProfiles("interrupted")).rejects.toThrow("interrupted");
      } finally {
        owned.close();
      }
      expect(inspectSqliteSchemaVersion({ databasePath: f.databasePath })).toBe(
        step === "backed-up" ? 9 : 12,
      );
      expect(
        inspectSqliteSchemaVersion({
          databasePath: join(f.root, "backups", "interrupted", "database.sqlite"),
        }),
      ).toBe(9);
      const restarted = open(f);
      try {
        await expect(restarted.app.upgradeProfiles("interrupted")).rejects.toThrow();
        if (step === "backed-up")
          expect(await restarted.app.upgradeProfiles("retry")).toMatchObject({ schemaVersion: 12 });
      } finally {
        restarted.close();
      }
    },
  );

  it("refuses incompatible generated assets before creating a backup or migrating", async () => {
    const f = profileUpgradeInstallation();
    f.writeAsset("assets/main.js", 'const revision = "other";');
    const owned = open(f);
    try {
      await expect(owned.app.upgradeProfiles("rejected")).rejects.toMatchObject({
        code: "prerequisite-unavailable",
      });
      expect(existsSync(join(f.root, "backups", "rejected"))).toBe(false);
      expect(inspectSqliteSchemaVersion({ databasePath: f.databasePath })).toBe(9);
    } finally {
      owned.close();
    }
    f.writeHost({ invalid: true });
    expect(await readInstallationStatus(f.root)).toMatchObject({
      host: null,
      profileUpgrade: { release: { ready: false, reason: "host-release-config" } },
    });
    rmSync(join(f.root, "config", "teacher-host.json"));
    expect(profileReleaseReadiness(f.root, "release:host")).toMatchObject({
      ready: false,
      reason: "host-release-config",
    });
  });
});
