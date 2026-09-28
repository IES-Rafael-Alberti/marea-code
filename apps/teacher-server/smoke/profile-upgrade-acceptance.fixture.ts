import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { teacherHostInstallation } from "../src/platform/teacher-host/teacher-host.fixture.js";

export function actualReleaseInstallation() {
  const f = teacherHostInstallation({ teacher: false });
  const dist = resolve(import.meta.dir, "../../dashboard/dist");
  cpSync(dist, f.host.dashboardDistPath, { recursive: true });
  secureDashboard(f.host.dashboardDistPath);
  f.writeHost({ ...f.host, allowedHosts: ["127.0.0.1"], allowedOrigins: ["http://127.0.0.1"] });
  const operation = (
    binary: string,
    name: string,
    payload?: object,
    status = 0,
    flags: string[] = [],
  ) => {
    const input = payload === undefined ? [] : ["--input", f.work("profile-command.json", payload)];
    const result = spawnSync(
      binary,
      ["--installation", f.root, ...name.split(" "), ...input, ...flags],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.status, status, `${name}: ${result.stderr}`);
    return status === 0 ? z.record(z.string(), z.json()).parse(JSON.parse(result.stdout)) : {};
  };
  const query = (sql: string) => {
    const file = openSqliteDatabaseFile({ databasePath: f.databasePath });
    try {
      return file.database.readOne(sql);
    } finally {
      file.close();
    }
  };
  return {
    ...f,
    operation,
    query,
    readJson: (path: string) =>
      z.record(z.string(), z.json()).parse(JSON.parse(readFileSync(path, "utf8"))),
  };
}

export function secureDashboard(path: string): void {
  chmodSync(path, 0o700);
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    chmodSync(child, item.isDirectory() ? 0o700 : 0o600);
    if (item.isDirectory()) secureDashboard(child);
  }
}
