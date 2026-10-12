import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock(
  "bun:sqlite",
  () => import("../../apps/teacher-server/src/platform/operator-cli/bun-sqlite.fixture.js"),
);
import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.js";
import {
  cleanupTeacherHostInstallations,
  teacherHostInstallation,
} from "../../apps/teacher-server/src/platform/teacher-host/teacher-host.fixture.js";
import {
  activatePreviewServer,
  assertPreviewServerIdle,
} from "./preview-server-update.boundary.js";

afterEach(cleanupTeacherHostInstallations);

it("refuses an actual held lock before download and rechecks ownership when activation starts", async () => {
  const f = teacherHostInstallation();
  const database = readFileSync(f.databasePath);
  const host = readFileSync(join(f.root, "config/teacher-host.json"));
  const lock = join(f.root, "locks/installation.lock");
  const activate = vi.fn(() => Promise.resolve());
  assertPreviewServerIdle(f.root);
  const owner = acquireInstallation(f.root);
  const record = readFileSync(lock);
  try {
    expect(() => {
      assertPreviewServerIdle(f.root);
    }).toThrow("installation-busy");
    await expect(
      activatePreviewServer(f.root, "/unused", "0.1.0-preview.31", activate),
    ).rejects.toThrow("installation-busy");
    expect(activate).not.toHaveBeenCalled();
    expect(readFileSync(lock)).toEqual(record);
    expect(readFileSync(f.databasePath)).toEqual(database);
    expect(readFileSync(join(f.root, "config/teacher-host.json"))).toEqual(host);
    expect(readdirSync(join(f.root, "backups"))).toEqual([]);
  } finally {
    owner.release();
  }
  expect(() => {
    assertPreviewServerIdle(f.root);
  }).not.toThrow();
  expect(readdirSync(join(f.root, "locks"))).toEqual([]);
});
