import { describe, expect, it } from "vitest";

import { DatabaseFake } from "../../../test-support/database-fake.js";
import type { PreparedIdentityBootstrap } from "../../identity/contracts.js";
import { SqliteIdentityRepository } from "./sqlite-identity-repository.js";

const SEED: PreparedIdentityBootstrap = {
  accounts: [
    {
      classKey: "physics",
      displayName: "Teacher Ada",
      login: "ada",
      passwordHash: "argon:teacher",
      role: "teacher",
      userId: "user:ada",
    },
    {
      classKey: "physics",
      displayName: "Student Alice",
      login: "alice",
      passwordHash: "argon:student",
      role: "student",
      userId: "user:alice",
    },
    {
      classKey: null,
      displayName: "Teacher Root",
      login: "root",
      passwordHash: "argon:root",
      role: "teacher",
      userId: "user:root",
    },
  ],
  classes: [{ classId: "class:physics", displayName: "Physics", key: "physics" }],
  invitations: [{ classKey: "physics", codeHash: "digest:invite" }],
  seedId: "seed-v1",
};

describe("SQLite identity repository", () => {
  it("applies an explicit bootstrap once with teacher access and invitation references", () => {
    const database = new DatabaseFake();
    database.oneRows.push(
      undefined,
      { id: "class:physics" },
      { id: "class:physics" },
      { id: "class:physics" },
    );
    const repository = new SqliteIdentityRepository(database);

    expect(repository.applyBootstrap(SEED, "2026-09-03T10:00:00.000Z")).toBe(true);
    expect(database.transactions).toBe(1);
    expect(
      database.reads.map(({ parameters, sql }) => ({ parameters, sql: sql.length > 0 })),
    ).toEqual([
      { parameters: ["seed-v1"], sql: true },
      { parameters: ["physics"], sql: true },
      { parameters: ["physics"], sql: true },
      { parameters: ["physics"], sql: true },
    ]);
    expect(database.executions).toHaveLength(16);
    expect(database.executions.every(({ sql }) => sql.length > 0)).toBe(true);
    const legacyWrites = database.executions.filter(
      ({ sql }) => !/INSERT INTO marea_(governance|center)_/u.test(sql),
    );
    expect(legacyWrites.map(({ parameters }) => parameters)).toEqual([
      ["class:physics", "physics", "Physics"],
      ["user:ada", "ada", "argon:teacher", "teacher", "Teacher Ada", "class:physics"],
      ["user:ada", "class:physics"],
      ["user:alice", "alice", "argon:student", "student", "Student Alice", "class:physics"],
      ["user:root", "root", "argon:root", "teacher", "Teacher Root", null],
      ["digest:invite", "class:physics"],
      ["seed-v1", "2026-09-03T10:00:00.000Z"],
    ]);
    expect(database.executions.at(-1)?.parameters).toEqual(["seed-v1", "2026-09-03T10:00:00.000Z"]);

    const replay = new DatabaseFake();
    replay.oneRows.push({ seed_id: "seed-v1" });
    expect(new SqliteIdentityRepository(replay).applyBootstrap(SEED, "later")).toBe(false);
    expect(replay.executions).toHaveLength(0);
  });

  it("rejects a bootstrap with a missing class reference", () => {
    const database = new DatabaseFake();
    database.oneRows.push(undefined, undefined);
    const teacher = SEED.accounts[0];
    if (teacher === undefined) {
      throw new Error("Expected the teacher fixture.");
    }
    expect(() =>
      new SqliteIdentityRepository(database).applyBootstrap(
        {
          ...SEED,
          accounts: [teacher],
          invitations: [],
        },
        "2026-09-03T10:00:00.000Z",
      ),
    ).toThrow("Bootstrap class reference is invalid.");
    expect(
      database.reads.map(({ parameters, sql }) => ({ parameters, sql: sql.length > 0 })),
    ).toEqual([
      { parameters: ["seed-v1"], sql: true },
      { parameters: ["physics"], sql: true },
    ]);
  });

  it("consumes a valid invitation atomically and rejects replay, unknown, or duplicate login", () => {
    const input = {
      codeHash: "digest:invite",
      displayName: "Student Alice",
      enrolledAt: "2026-09-03T10:00:00.000Z",
      login: "alice",
      passwordHash: "argon:student",
      userId: "user:alice",
    };
    const success = new DatabaseFake();
    success.oneRows.push({ class_id: "class:physics", consumed_at: null }, undefined);
    expect(new SqliteIdentityRepository(success).consumeInvitation(input)).toEqual({
      enrolled: true,
      identity: {
        classId: "class:physics",
        displayName: "Student Alice",
        role: "student",
        userId: "user:alice",
      },
    });
    expect(success.executions).toHaveLength(5);
    expect(
      success.reads.map(({ parameters, sql }) => ({ parameters, sql: sql.length > 0 })),
    ).toEqual([
      { parameters: ["digest:invite"], sql: true },
      { parameters: ["alice"], sql: true },
    ]);
    expect(
      success.executions
        .slice(0, 2)
        .map(({ parameters, sql }) => ({ parameters, sql: sql.length > 0 })),
    ).toEqual([
      {
        parameters: ["user:alice", "alice", "argon:student", "Student Alice", "class:physics"],
        sql: true,
      },
      {
        parameters: ["digest:invite", "2026-09-03T10:00:00.000Z", "user:alice"],
        sql: true,
      },
    ]);

    for (const rows of [
      [undefined, undefined],
      [{ class_id: "class:physics", consumed_at: "already" }, undefined],
      [{ class_id: "class:physics", consumed_at: null }, { id: "existing" }],
    ]) {
      const rejected = new DatabaseFake();
      rejected.oneRows.push(...rows);
      expect(new SqliteIdentityRepository(rejected).consumeInvitation(input)).toEqual({
        enrolled: false,
      });
      expect(rejected.executions).toHaveLength(0);
    }
  });

  it("stores and resolves only hashed sessions and validates credential rows", () => {
    const database = new DatabaseFake();
    const repository = new SqliteIdentityRepository(database);
    repository.createSession({
      expiresAt: "2026-09-03T10:30:00.000Z",
      issuedAt: "2026-09-03T10:00:00.000Z",
      sessionId: "session:1",
      tokenHash: "digest:token",
      userId: "user:alice",
    });
    expect(database.executions[0]?.parameters).toContain("digest:token");
    expect(database.executions[0]?.sql.length).toBeGreaterThan(0);
    expect(database.executions[0]?.parameters).toEqual([
      "session:1",
      "user:alice",
      "digest:token",
      "2026-09-03T10:00:00.000Z",
      "2026-09-03T10:30:00.000Z",
    ]);

    database.oneRows.push({
      class_id: "class:physics",
      display_name: "Student Alice",
      id: "user:alice",
      password_hash: "argon:student",
      role: "student",
    });
    expect(repository.findCredential("alice")).toEqual({
      classId: "class:physics",
      displayName: "Student Alice",
      passwordHash: "argon:student",
      role: "student",
      userId: "user:alice",
    });
    expect(database.reads.at(-1)?.parameters).toEqual(["alice"]);
    expect(database.reads.at(-1)?.sql).toContain("marea_users");
    database.oneRows.push(undefined);
    expect(repository.findCredential("missing")).toBeUndefined();

    database.oneRows.push({
      class_id: null,
      display_name: "Teacher Ada",
      id: "user:ada",
      role: "teacher",
    });
    expect(repository.resolveSession("digest:token", "now")?.role).toBe("teacher");
    expect(database.reads.at(-1)?.parameters).toEqual(["digest:token", "now"]);
    expect(database.reads.at(-1)?.sql).toContain("marea_auth_sessions");
    database.oneRows.push(undefined);
    expect(repository.resolveSession("digest:missing", "now")).toBeUndefined();

    database.oneRows.push({
      class_id: null,
      display_name: "Invalid",
      id: "user:invalid",
      password_hash: "hash",
      role: "admin",
    });
    expect(() => repository.findCredential("invalid")).toThrow("Stored teacher data is invalid.");
  });

  it("revokes active sessions once and reports an idempotent retry", () => {
    const active = new DatabaseFake();
    active.oneRows.push({ id: "session:1" });
    expect(new SqliteIdentityRepository(active).revokeSession("digest:token", "now")).toBe(true);
    expect(active.executions).toHaveLength(1);
    expect(active.reads[0]?.parameters).toEqual(["digest:token"]);
    expect(active.reads[0]?.sql).toContain("marea_auth_sessions");
    expect(active.executions[0]?.parameters).toEqual(["digest:token", "now"]);
    expect(active.executions[0]?.sql).toContain("marea_auth_sessions");

    const revoked = new DatabaseFake();
    revoked.oneRows.push(undefined);
    expect(new SqliteIdentityRepository(revoked).revokeSession("digest:token", "now")).toBe(false);
    expect(revoked.executions).toHaveLength(0);
  });
});
