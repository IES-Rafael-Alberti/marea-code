import { OpenRunRequestSchema, StudentRunSnapshotSchema } from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMigrationCatalog } from "@marea/sqlite-storage/migrations";
import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import type { RunSnapshotSource } from "../../sessions/contracts.js";
import { RunSessionService } from "../../sessions/run-session-service.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

const student: AuthenticatedIdentity = {
  role: "student",
  userId: "student:one",
  classId: "class:one",
  displayName: "Synthetic student",
};
const snapshot = StudentRunSnapshotSchema.parse({
  id: "snapshot:initial",
  agentMode: "free",
  modelAlias: "marea",
  didacticSkills: [],
  prompt: {
    version: "prompt:1",
    content: "Synthetic instructions",
    digest: `sha256:${"a".repeat(64)}`,
  },
  teacherToolPolicy: { version: "policy:1", restrictions: [] },
});
const request = OpenRunRequestSchema.parse({
  protocolVersion: "0.1",
  clientVersion: "0.0.0",
  requestId: "request:one",
  idempotencyKey: "open:one",
  clientSessionId: "client:one",
  project: { displayName: "Synthetic project" },
  intent: { kind: "new" },
});

describe("transactional run capture", () => {
  let database: NodeSqliteTestDatabase;
  let service: RunSessionService;
  let capture: ReturnType<typeof vi.fn<RunSnapshotSource["capture"]>>;

  beforeEach(() => {
    database = new NodeSqliteTestDatabase();
    for (const migration of createMigrationCatalog())
      for (const statement of migration.statements) database.executeScript(statement);
    database.execute(
      "INSERT INTO marea_classes (id, seed_key, display_name) VALUES (?1, 'synthetic', ?2)",
      [student.classId, "Synthetic class"],
    );
    database.execute(
      "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES (?1, ?2, ?3, 'student', ?4, ?5)",
      [student.userId, "synthetic", "synthetic-hash", student.displayName, student.classId],
    );
    capture = vi.fn<RunSnapshotSource["capture"]>((id) => ({
      snapshot: StudentRunSnapshotSchema.parse({ ...snapshot, id }),
      providerRoute: { providerId: "synthetic", model: "synthetic-model" },
    }));
    let idSequence = 0;
    let tokenSequence = 0;
    service = new RunSessionService({
      clock: { now: () => "2026-09-07T12:00:00.000Z" },
      digest: { digest: (token) => `digest:${token}` },
      ids: { createId: (namespace) => `${namespace}:${String(++idSequence)}` },
      secrets: { issue: () => `synthetic_token_${String(++tokenSequence).padStart(32, "0")}` },
      snapshots: { capture },
      repository: new SqliteRunSessionRepository(database),
    });
  });
  afterEach(() => {
    database.close();
  });

  it("captures once inside the transaction and never reloads for retry or resume", () => {
    capture.mockImplementationOnce((id, identity) => {
      expect(identity).toBe(student);
      // A nested BEGIN must fail: capture is part of the run's transaction.
      expect(() => {
        database.execute("BEGIN IMMEDIATE");
      }).toThrow();
      return {
        snapshot: StudentRunSnapshotSchema.parse({ ...snapshot, id }),
        providerRoute: { providerId: "synthetic", model: "frozen-model" },
      };
    });
    const opened = service.open(student, request);
    expect(capture).toHaveBeenCalledTimes(1);
    capture.mockImplementation(() => {
      throw new Error("Configuration no longer available");
    });
    expect(service.open(student, request).snapshot).toEqual(opened.snapshot);
    const resumed = service.open(
      student,
      OpenRunRequestSchema.parse({
        ...request,
        idempotencyKey: "resume:one",
        intent: { kind: "resume" },
        runId: opened.lease.runId,
      }),
    );
    expect(resumed.snapshot).toEqual(opened.snapshot);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(database.readOne("SELECT COUNT(*) AS count FROM marea_run_snapshots")).toEqual({
      count: 1n,
    });
    expect(() =>
      service.open(student, {
        ...request,
        idempotencyKey: OpenRunRequestSchema.parse({ ...request, idempotencyKey: "open:two" })
          .idempotencyKey,
      }),
    ).toThrow("Configuration no longer available");
    expect(database.readOne("SELECT COUNT(*) AS count FROM marea_runs")).toEqual({ count: 1n });
  });

  it("rejects a malformed capture before any run data becomes durable", () => {
    const invalidSnapshot = { ...snapshot, privateNotes: "Never public" };
    capture.mockReturnValue({
      snapshot: invalidSnapshot,
      providerRoute: { providerId: "synthetic", model: "synthetic-model" },
    });
    expect(() => service.open(student, request)).toThrow();
    for (const table of [
      "marea_runs",
      "marea_run_snapshots",
      "marea_run_events",
      "marea_run_leases",
    ]) {
      expect(database.readOne(`SELECT COUNT(*) AS count FROM ${table}`)).toEqual({ count: 0n });
    }
  });
});
