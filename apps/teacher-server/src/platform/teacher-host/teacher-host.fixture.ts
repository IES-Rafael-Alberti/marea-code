import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { initializeSqliteStorage } from "@marea/sqlite-storage";

import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { installationFixture } from "../operator-cli/installation.fixture.js";
import { createOperationsApplication } from "../operations-cli/operations-application.js";
import { readOperationsConfig } from "../operations-cli/operations-config.js";
import type { ServePort } from "./teacher-host.js";

const HOST_NOW = "2026-09-14T10:00:00.000Z";
const created: string[] = [];

export function cleanupTeacherHostInstallations(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A private GOVERNANCE installation plus OPERATIONS operations and teacher host configuration; node-backed `bun:sqlite`. */
export function teacherHostInstallation(
  options: {
    readonly activate?: boolean;
    readonly teacher?: boolean;
    readonly readyClasses?: readonly string[];
  } = {},
) {
  const f = installationFixture(options.readyClasses);
  created.push(f.root);
  const storage = initializeSqliteStorage({ databasePath: f.databasePath });
  if (options.teacher ?? true)
    storage.database.execute(
      "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('user:teacher', 'teacher', 'hash:teacher-password', 'teacher', 'Teacher', NULL)",
    );
  storage.close();
  for (const directory of ["backups", "state", "dashboard", "dashboard/assets"])
    mkdirSync(join(f.root, directory), { mode: 0o700 });
  writeFileSync(join(f.root, "dashboard", "index.html"), "<!doctype html><title>Marea</title>", {
    mode: 0o600,
  });
  writeFileSync(join(f.root, "state", "digest.key"), new Uint8Array(32).fill(3), { mode: 0o600 });
  writeFileSync(
    join(f.root, "config", "operations.json"),
    JSON.stringify({
      version: 1,
      databasePath: f.databasePath,
      indexPath: join(f.root, "state", "deletion-index.sqlite"),
      backupRoot: join(f.root, "backups"),
      authorityLineage: "lineage:host",
      rootId: "root:host",
      databaseLineage: `sha256:${"a".repeat(64)}`,
      releaseId: "release:host",
      limits: { fileCount: 4, fileBytes: 1_000_000, totalBytes: 2_000_000 },
      stateFiles: [],
    }),
    { mode: 0o600 },
  );
  const host = {
    version: 1,
    releaseId: "release:host",
    listen: { hostname: "127.0.0.1", port: 0 },
    allowedHosts: ["teacher.test"],
    allowedOrigins: ["https://dashboard.test"],
    secureDashboardCookie: false,
    serverVersion: "0.2.0",
    statusPath: join(f.root, "state", "host-status.json"),
    digestKeyPath: join(f.root, "state", "digest.key"),
    dashboardDistPath: join(f.root, "dashboard"),
    providers: [],
    retry: { delayMs: 10, maxDelayMs: 100 },
    evaluationIntervalMs: 60_000,
    shutdownDrainMs: 1_000,
  };
  const writeHost = (value: unknown) => {
    writeFileSync(join(f.root, "config", "teacher-host.json"), JSON.stringify(value), {
      mode: 0o600,
    });
  };
  writeHost(host);
  if (options.activate ?? true) {
    const owned = acquireInstallation(f.root);
    try {
      createOperationsApplication(
        owned.capability,
        readOperationsConfig(f.root),
        () => HOST_NOW,
      ).activate();
    } finally {
      owned.release();
    }
  }
  const served: { fetch?: (request: Request) => Promise<Response>; stopped: boolean } = {
    stopped: false,
  };
  const serve: ServePort = (input) => {
    served.fetch = input.fetch;
    return {
      url: `http://${input.hostname}:${String(input.port)}`,
      stop: () => {
        served.stopped = true;
        return Promise.resolve();
      },
    };
  };
  return { ...f, host, writeHost, serve, served };
}
