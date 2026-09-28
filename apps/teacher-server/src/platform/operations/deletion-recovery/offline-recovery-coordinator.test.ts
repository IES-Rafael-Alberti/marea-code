import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { describe, expect, it } from "vitest";

import type { HostDatabaseMode, HostInstallationConfig } from "../host/contracts.js";
import { createOfflineRecoveryCoordinator } from "./offline-recovery-coordinator.js";

const CONFIG: HostInstallationConfig = {
  releaseId: "release:one",
  schemaVersion: 9,
  databasePath: "/installation/application.sqlite",
  indexPath: "/installation/deletion-index.sqlite",
  statusPath: "/installation/status.json",
};

function ports(options: { mode?: HostDatabaseMode; validate?: () => Promise<void> } = {}) {
  const events: unknown[] = [];
  const database = { name: "database" } as unknown as SqliteApplicationDatabase;
  const coordinator = createOfflineRecoveryCoordinator({
    installationRoot: "/requested",
    exclusivity: {
      acquire: (root) => {
        events.push(["acquire", root]);
        return Promise.resolve({
          canonicalRoot: "/installation",
          release: () => {
            events.push("release");
            return Promise.resolve();
          },
        });
      },
      inspect: () => Promise.resolve("free"),
    },
    configuration: {
      read: (input) => {
        events.push(["read", input]);
        return Promise.resolve(CONFIG);
      },
      validate: (input) => {
        events.push(["validate", input]);
        return options.validate?.() ?? Promise.resolve();
      },
    },
    storage: {
      open: (input) => {
        events.push(["open", input]);
        return Promise.resolve({
          mode: options.mode ?? "read-write",
          database,
          close: () => {
            events.push("close");
          },
        });
      },
    },
  });
  return { coordinator, database, events };
}

describe("offline recovery coordinator", () => {
  it("runs one operation on a validated writable database inside the installation lock", async () => {
    const { coordinator, database, events } = ports();
    const result = await coordinator.exclusive((view) => {
      events.push(["operation", view === database]);
      return Promise.resolve("done");
    });
    expect(result).toBe("done");
    expect(events).toEqual([
      ["acquire", "/requested"],
      ["read", { installationRoot: "/installation" }],
      [
        "validate",
        { installationRoot: "/installation", config: CONFIG, requestedReleaseId: "release:one" },
      ],
      ["open", { installationRoot: "/installation", config: CONFIG, mode: "read-write" }],
      ["operation", true],
      "close",
      "release",
    ]);
  });

  it("closes and releases after failures and refuses read-only handles", async () => {
    const failing = ports();
    const failure = new Error("operation failed");
    await expect(failing.coordinator.exclusive(() => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(failing.events.slice(-2)).toEqual(["close", "release"]);

    const readOnly = ports({ mode: "read-only" });
    await expect(readOnly.coordinator.exclusive(() => Promise.resolve(1))).rejects.toMatchObject({
      code: "not-ready",
      message: "recovery requires a writable database",
    });
    expect(readOnly.events.slice(-2)).toEqual(["close", "release"]);

    const invalid = ports({ validate: () => Promise.reject(new Error("invalid config")) });
    await expect(invalid.coordinator.exclusive(() => Promise.resolve(1))).rejects.toThrow(
      "invalid config",
    );
    expect(invalid.events.at(-1)).toBe("release");
    expect(invalid.events.some((event) => Array.isArray(event) && event[0] === "open")).toBe(false);
  });
});
