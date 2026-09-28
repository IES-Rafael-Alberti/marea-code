import { vi, expect } from "vitest";
vi.mock("bun:sqlite", () => ({
  Database: class {
    readonly mocked = true;
  },
}));
import { createProfileMigrationCatalog, createDashboardProfileStore } from "@marea/sqlite-storage";
import { NodeSqliteTestDatabase } from "../../test-support/node-sqlite-database.boundary.js";
import { composeDashboardProfiles } from "../platform/teacher-host/profile-composition.js";
import type { AuthenticatedIdentity } from "../identity/contracts.js";

export { release, selected, schemas } from "./release.fixture.js";
import { release, schemas } from "./release.fixture.js";
export const teacher: AuthenticatedIdentity = {
  userId: "teacher-1",
  role: "teacher",
  displayName: "Synthetic",
  classId: null,
};
const teacherScope = { kind: "teacher" } as const;
export const classScope = { kind: "class", classId: "class-1" } as const;
export const encode = (value: object) => new TextEncoder().encode(JSON.stringify(value));
export const request = (operation: string, extra: object = {}) => ({
  protocolVersion: "0.1",
  requestId: "profile-request",
  kind: `dashboard-profile-${operation}`,
  scope: teacherScope,
  ...extra,
});
export const write = (extra: object = {}) =>
  request("save", {
    expectedRevision: null,
    expectedPersonalRevision: null,
    catalogRevision: release.revision,
    discardUnavailable: false,
    value: release.defaults,
    ...extra,
  });
export function profileHarness() {
  const database = new NodeSqliteTestDatabase();
  database.execute("PRAGMA foreign_keys = ON");
  for (const migration of createProfileMigrationCatalog())
    for (const sql of migration.statements) database.execute(sql);
  database.execute("INSERT INTO marea_classes VALUES ('class-1','seed-1','One')");
  for (const id of ["teacher-1", "teacher-2"]) {
    database.execute("INSERT INTO marea_users VALUES (?1,?1,'hash','teacher','Synthetic',NULL)", [
      id,
    ]);
    database.execute("INSERT INTO marea_teacher_classes VALUES (?1,'class-1')", [id]);
  }
  let revision = 0;
  const runtime = { catalogRevision: release.revision, permitted: true };
  const service = composeDashboardProfiles({
    database,
    release,
    currentCatalogRevision: () => runtime.catalogRevision,
    clock: { now: () => "2026-09-22T12:00:00Z" },
    ids: {
      createId: (namespace) => {
        expect(namespace).toBe("revision");
        return `profile-${String(++revision)}`;
      },
    },
    authority: { permits: () => runtime.permitted },
  });
  const execute = (operation: string, value: object, actor = teacher) =>
    service.execute(actor, operation, encode(value));
  const read = (scope: object = teacherScope, actor = teacher) =>
    schemas.state.parse(execute("read", request("read", { scope }), actor));
  return {
    database,
    service,
    runtime,
    execute,
    read,
    store: createDashboardProfileStore(database),
  };
}
