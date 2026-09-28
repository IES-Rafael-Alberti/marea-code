import { inspectSqliteSchemaVersion } from "@marea/sqlite-storage";
import { afterEach, expect, it, vi } from "vitest";
import type { InstallationCapability } from "../../governance/authority.js";
import { cleanupTeacherHostInstallations } from "../teacher-host/teacher-host.fixture.js";
import { readOperationsConfig } from "./operations-config.js";
import { profileUpgradeInstallation } from "./profile-upgrade.fixture.js";
import { upgradeProfilesOffline } from "./profile-upgrade.js";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
afterEach(cleanupTeacherHostInstallations);

it.each(["before-backup", "after-backup"])(
  "refuses lost ownership %s before any migration",
  async (when) => {
    const f = profileUpgradeInstallation();
    let owned = when === "after-backup";
    const failure = new Error("ownership lost");
    const capability: InstallationCapability = {
      kind: "exclusive-installation-owner",
      installationRoot: f.root,
      assertOwned() {
        if (!owned) throw failure;
      },
    };
    const backup = vi.fn(() => {
      owned = false;
      return Promise.resolve("/private/backup");
    });
    await expect(
      upgradeProfilesOffline(capability, readOperationsConfig(f.root), backup),
    ).rejects.toBe(failure);
    expect(backup).toHaveBeenCalledTimes(when === "after-backup" ? 1 : 0);
    expect(inspectSqliteSchemaVersion({ databasePath: f.databasePath })).toBe(9);
  },
);
