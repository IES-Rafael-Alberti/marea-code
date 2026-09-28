import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { readInstallationStatus, runInstallationStatus } from "./installation-status.js";
import { cleanupOperationsInstallations, operationsInstallation } from "./operations.fixture.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

afterEach(cleanupOperationsInstallations);

function setVersion(path: string, version: number): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA user_version = ${String(version)}`);
  } finally {
    database.close();
  }
}

describe("lock-free installation status", () => {
  it("previews initialization, activation, currency and unsupported newer schemas", async () => {
    const f = operationsInstallation();
    const status = () => readInstallationStatus(f.root);
    expect(await status()).toEqual({
      releaseId: "release:one",
      schemaVersion: 8,
      supportedSchemaVersion: 9,
      upgrade: "activate",
      locked: false,
      host: null,
    });
    const owned = acquireInstallation(f.root);
    try {
      expect(await status()).toMatchObject({ locked: true, upgrade: "activate" });
    } finally {
      owned.release();
    }
    writeFileSync(join(f.root, ".marea-installation.lock"), "{}", { mode: 0o600 });
    expect(await status()).toMatchObject({ locked: true });
    rmSync(join(f.root, ".marea-installation.lock"));
    expect(await f.run("deletion", "activate")).toMatchObject({ code: 0 });
    expect(await status()).toMatchObject({ schemaVersion: 9, upgrade: "none" });
    setVersion(f.config.databasePath, 11);
    expect(await status()).toMatchObject({ schemaVersion: 11, upgrade: "unsupported" });
    setVersion(f.config.databasePath, 0);
    expect(await status()).toMatchObject({ schemaVersion: 0, upgrade: "activate" });
    rmSync(f.config.databasePath);
    expect(await status()).toMatchObject({ schemaVersion: null, upgrade: "initialize" });
  });

  it("reports the recorded host status when a teacher host is configured", async () => {
    const f = operationsInstallation();
    mkdirSync(join(f.root, "state"), { mode: 0o700 });
    mkdirSync(join(f.root, "dashboard"), { mode: 0o700 });
    writeFileSync(join(f.root, "state", "digest.key"), new Uint8Array(32), { mode: 0o600 });
    const statusPath = join(f.root, "state", "host-status.json");
    writeFileSync(
      join(f.root, "config", "teacher-host.json"),
      JSON.stringify({
        version: 1,
        releaseId: "release:one",
        listen: { hostname: "127.0.0.1", port: 0 },
        allowedHosts: ["127.0.0.1"],
        allowedOrigins: ["http://127.0.0.1"],
        secureDashboardCookie: false,
        serverVersion: "0.2.0",
        statusPath,
        digestKeyPath: join(f.root, "state", "digest.key"),
        dashboardDistPath: join(f.root, "dashboard"),
        providers: [],
        retry: { delayMs: 1, maxDelayMs: 1 },
        evaluationIntervalMs: 1,
        shutdownDrainMs: 1,
      }),
      { mode: 0o600 },
    );
    expect(await readInstallationStatus(f.root)).toMatchObject({ host: null });
    writeFileSync(
      statusPath,
      JSON.stringify({
        status: "ready",
        releaseId: "release:one",
        schemaVersion: 9,
        reasonCode: "ready",
        observedAt: "2026-09-14T10:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    expect(await readInstallationStatus(f.root)).toMatchObject({
      host: { status: "ready", releaseId: "release:one", observedAt: "2026-09-14T10:00:00.000Z" },
    });
  });

  it("prints one JSON line or a closed prerequisite diagnostic", async () => {
    const f = operationsInstallation();
    const output = { stdout: [] as string[], stderr: [] as string[] };
    const ports = {
      stdout: (text: string) => {
        output.stdout.push(text);
      },
      stderr: (text: string) => {
        output.stderr.push(text);
      },
    };
    expect(await runInstallationStatus(f.root, ports)).toBe(0);
    expect(output.stdout).toEqual([`${JSON.stringify(await readInstallationStatus(f.root))}\n`]);
    for (const root of [join(f.root, "missing"), f.root]) {
      if (root === f.root) writeFileSync(join(f.root, "config", "operations.json"), "{}");
      output.stderr.length = 0;
      expect(await runInstallationStatus(root, ports)).toBe(5);
      expect(output.stderr).toEqual(["Operator prerequisites are unavailable.\n"]);
    }
    // A backup root that is not a directory is refused by the configuration reader itself.
    f.writeConfig({ ...f.config, backupRoot: f.config.databasePath });
    output.stderr.length = 0;
    expect(await runInstallationStatus(f.root, ports)).toBe(5);
    expect(output.stdout).toHaveLength(1);
  });
});
