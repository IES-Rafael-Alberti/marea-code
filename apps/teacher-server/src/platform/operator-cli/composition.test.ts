import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMigrationCatalog } from "@marea/sqlite-storage/migrations";
import {
  readOperatorCliConfig,
  composeInstallation,
  createOperatorCliApplication,
} from "./composition.js";
import { acquireInstallation } from "./installation-lock.js";
import { RequestIdSchema } from "@marea/protocol";
import { installationFixture, skillMarkdown } from "./installation.fixture.js";
import { OperatorCliError } from "./errors.js";
import { nativeOpens } from "./bun-sqlite.fixture.js";
import { runOperatorCli } from "./cli.js";
import { PasswordInput } from "./filesystem.fixture.js";
import { CLI_NOW } from "./application.fixture.js";

vi.mock("bun:sqlite", () => import("./bun-sqlite.fixture.js"));
const hasher = vi.hoisted(() => ({
  hash: vi.fn((secret: string) => Promise.resolve(`synthetic-hash:${secret}`)),
  verify: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../identity/password-hasher.boundary.js", () => ({
  bunArgon2idPasswordHasher: hasher,
}));
const roots = new Set<string>();
function fixture() {
  const f = installationFixture();
  roots.add(f.root);
  return f;
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
  nativeOpens.length = 0;
  vi.restoreAllMocks();
});

describe("explicit private configuration graph", () => {
  it("rejects malformed UTF-8 inside otherwise valid owner text and independent duplicate IDs", () => {
    const f = fixture();
    const config = JSON.stringify({
      ...f.config,
      centers: [{ ...f.config.centers[0], id: "invalid-byte" }],
    });
    const [before, after] = config.split("invalid-byte");
    writeFileSync(
      f.configPath,
      Buffer.concat([Buffer.from(before ?? ""), Buffer.from([0xff]), Buffer.from(after ?? "")]),
    );
    expect(() => readOperatorCliConfig(f.root)).toThrow();
    f.writeConfig({
      ...f.config,
      centers: [...f.config.centers, { id: "center:a", root: join(f.root, "work") }],
    });
    expect(() => readOperatorCliConfig(f.root)).toThrow(
      new OperatorCliError("prerequisite-unavailable"),
    );
    f.writeConfig({
      ...f.config,
      personalOwners: [
        ...f.config.personalOwners,
        { classId: "class:other", teacherId: "user:teacher" },
      ],
    });
    expect(readOperatorCliConfig(f.root).personalOwners).toHaveLength(2);
    f.writeConfig({
      ...f.config,
      personalOwners: [
        ...f.config.personalOwners,
        { classId: "class:other", teacherId: "user:missing" },
      ],
    });
    expect(() => readOperatorCliConfig(f.root)).toThrow(
      new OperatorCliError("prerequisite-unavailable"),
    );
  });
  it("reads the exact strict document and canonical owned graph", () => {
    const f = fixture();
    expect(readOperatorCliConfig(f.root)).toEqual(f.config);
    expect(readOperatorCliConfig(f.root, process.getuid?.())).toEqual(f.config);
  });
  it("rejects malformed/oversized/UTF-8 config, extra keys, unknown versions and invalid owner maps", () => {
    const f = fixture();
    const invalid = [
      null,
      {},
      { ...f.config, version: 2 },
      { ...f.config, extra: true },
      { ...f.config, centers: [{ ...f.config.centers[0], extra: true }] },
      { ...f.config, personalOwners: [{ classId: "class:a", teacherId: "missing" }] },
      { ...f.config, personalOwners: [f.config.personalOwners[0], f.config.personalOwners[0]] },
      { ...f.config, teachers: [{ ...f.config.teachers[0], id: "center:a" }] },
      { ...f.config, personalOwners: [{ classId: "", teacherId: "user:teacher" }] },
      { ...f.config, teachers: [{ id: 1, root: f.config.teachers[0]?.root }] },
      { ...f.config, centers: [{ id: "center:a", root: 1 }] },
    ];
    for (const value of invalid) {
      f.writeConfig(value);
      expect(() => readOperatorCliConfig(f.root)).toThrow();
    }
    for (const content of [
      Buffer.from([0xc3, 0x28]),
      Buffer.from("{}\0"),
      Buffer.from(" ".repeat(65_537)),
    ]) {
      writeFileSync(f.configPath, content);
      expect(() => readOperatorCliConfig(f.root)).toThrow();
    }
  });
  it("rejects insecure graph entries, aliases, overlap and reserved locations", () => {
    const f = fixture();
    for (const path of [
      f.configPath,
      join(f.root, "config"),
      f.databasePath,
      f.operatorPolicyPath,
      f.config.coreSourcePath,
      join(f.root, "centers"),
    ]) {
      chmodSync(path, 0o755);
      expect(() => readOperatorCliConfig(f.root)).toThrow();
      chmodSync(path, path.endsWith(".json") || path.endsWith(".sqlite") ? 0o600 : 0o700);
    }
    const variants = [
      { databasePath: f.config.coreSourcePath },
      { coreSourcePath: f.databasePath },
      { operatorPolicyPath: f.databasePath },
      { databasePath: f.configPath },
      { coreSourcePath: join(f.root, "locks") },
      { coreSourcePath: f.root },
      { teachers: [{ id: "user:teacher", root: f.config.coreSourcePath }] },
      { teachers: [{ id: "user:teacher", root: join(f.root, "centers") }] },
      { databasePath: `${f.root}/./marea.sqlite` },
      { databasePath: join(f.root, "missing") },
    ];
    for (const change of variants) {
      f.writeConfig({ ...f.config, ...change });
      expect(() => readOperatorCliConfig(f.root)).toThrow();
    }
    const foreign = fixture();
    f.writeConfig({ ...f.config, databasePath: foreign.databasePath });
    expect(() => readOperatorCliConfig(f.root)).toThrow();
    symlinkSync(f.databasePath, join(f.root, "alias.sqlite"));
    f.writeConfig({ ...f.config, databasePath: join(f.root, "alias.sqlite") });
    expect(() => readOperatorCliConfig(f.root)).toThrow();
    f.writeConfig(f.config);
    expect(() => readOperatorCliConfig(f.root, (process.getuid?.() ?? 0) + 1)).toThrow();
  });
});

describe("real SQLite installation composition", () => {
  it("composes real class-exchange sources including the explicitly configured personal owner", async () => {
    const f = fixture();
    const owned = acquireInstallation(f.root);
    const composed = composeInstallation(owned.capability);
    const context = {
      authority: owned.capability,
      now: CLI_NOW,
      requestId: RequestIdSchema.parse("request:source"),
    };
    try {
      await composed.application.createCenter({
        ...context,
        centerId: "center:a",
        displayName: "A",
        expectedVersion: null,
      });
      await composed.application.createClass({
        ...context,
        centerId: "center:a",
        classId: "class:ready",
        displayName: "Ready",
        expectedVersion: null,
      });
      const saved = await composed.application.saveSkill({
        ...context,
        owner: { source: "teacher", id: "user:teacher" },
        request: {
          kind: "didactic",
          slug: "example",
          files: [{ path: "SKILL.md", content: skillMarkdown("example") }],
          expectedDigest: null,
        },
      });
      const preview = await composed.application.previewClassImport({
        ...context,
        centerId: "center:a",
        classId: "class:ready",
        expectedTeachingVersion: null,
        package: {
          format: "marea-class-exchange:1",
          source: { displayName: "Imported" },
          agentMode: "free",
          classInstructions: { tutoring: "Tutor", free: "Free" },
          selection: { didactic: [{ id: saved.id, digest: saved.digest }], evaluation: [] },
        },
      });
      expect(preview.settings.selection.didactic).toEqual([{ id: saved.id, digest: saved.digest }]);
      const confirmed = await composed.application.confirmClassImport({
        ...context,
        centerId: "center:a",
        classId: "class:ready",
        previewId: preview.previewId,
      });
      expect(confirmed.teachingVersion).toMatch(/^revision:cli:/);
    } finally {
      composed.close();
      owned.release();
    }
  });
  it("reads the schema from the closed database file, then exposes real private operations and closes every connection", async () => {
    const f = fixture();
    const owned = acquireInstallation(f.root);
    const opened = nativeOpens.length;
    const composed = composeInstallation(owned.capability);
    // Without WAL or journal sidecars the schema probe reads the file header, not a connection.
    expect(nativeOpens.slice(opened).map((record) => record.options.readonly === true)).toEqual([
      false,
    ]);
    const context = {
      authority: owned.capability,
      now: CLI_NOW,
      requestId: RequestIdSchema.parse("request:test"),
    };
    const center = await composed.application.createCenter({
      ...context,
      centerId: "center:a",
      displayName: "Center",
      expectedVersion: null,
    });
    expect(center.version).toMatch(/^revision:cli:[0-9a-f-]{36}$/);
    const ready = await composed.application.createClass({
      ...context,
      centerId: "center:a",
      classId: "class:ready",
      displayName: "Ready",
      expectedVersion: null,
    });
    const notReady = await composed.application.createClass({
      ...context,
      centerId: "center:a",
      classId: "class:other",
      displayName: "Other",
      expectedVersion: null,
    });
    expect([ready.operatorReady, notReady.operatorReady]).toEqual([true, false]);
    const account = await composed.application.createAccount({
      ...context,
      centerId: "center:a",
      userId: "user:teacher",
      displayName: "Teacher",
      login: "teacher",
      role: "teacher",
      classId: null,
      expectedVersion: null,
    });
    expect(account.state).toBe("pending");
    expect(hasher.hash).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(
      await composed.application.listSkills({
        ...context,
        owner: { source: "teacher", id: "user:teacher" },
        kind: "didactic",
      }),
    ).toEqual([]);
    expect(
      await composed.application.listSkills({
        ...context,
        owner: { source: "center", id: "center:a" },
        kind: "didactic",
      }),
    ).toEqual([]);
    expect(
      await composed.application.listSkills({
        ...context,
        owner: { source: "marea" },
        kind: "didactic",
      }),
    ).toEqual([]);
    expect(composed.reserved).toEqual([
      join(f.root, "locks"),
      join(f.root, "config"),
      f.databasePath,
      `${f.databasePath}-wal`,
      `${f.databasePath}-shm`,
      `${f.databasePath}-journal`,
      f.operatorPolicyPath,
      f.config.centers[0]?.root,
      f.config.teachers[0]?.root,
      f.config.coreSourcePath,
    ]);
    composed.close();
    expect(nativeOpens.every((record) => record.closed)).toBe(true);
    expect(owned.release()).toBe(true);
  });
  it("does not create or migrate unsupported state or open it for the schema probe", () => {
    const f = fixture();
    const owned = acquireInstallation(f.root);
    for (const schema of [0, 7, createMigrationCatalog().length + 1]) {
      const db = new DatabaseSync(f.databasePath);
      db.exec(`PRAGMA user_version = ${String(schema)}`);
      db.close();
      const count = nativeOpens.length;
      expect(() => createOperatorCliApplication(owned.capability, f.config)).toThrow(
        "prerequisite-unavailable",
      );
      expect(nativeOpens.slice(count)).toHaveLength(0);
      const check = new DatabaseSync(f.databasePath);
      expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: schema });
      check.close();
    }
    owned.release();
  });
  it("rejects lost ownership before opening storage and cleans a partially composed application", () => {
    const f = fixture();
    const owned = acquireInstallation(f.root);
    owned.release();
    const count = nativeOpens.length;
    expect(() => createOperatorCliApplication(owned.capability, f.config)).toThrow(
      "installation-lost",
    );
    expect(nativeOpens).toHaveLength(count);
    expect(() => composeInstallation(owned.capability)).toThrow("installation-lost");
    const next = acquireInstallation(f.root);
    writeFileSync(f.operatorPolicyPath, "invalid private policy");
    expect(() => composeInstallation(next.capability)).toThrow("prerequisite-unavailable");
    expect(nativeOpens.every((record) => record.closed)).toBe(true);
    next.release();
    const third = acquireInstallation(f.root);
    f.writeConfig({ ...f.config, version: 2 });
    expect(() => composeInstallation(third.capability)).toThrow("prerequisite-unavailable");
    third.release();
  });
  it("validates all source owners and does not leave SQLite open when a constructor fails", () => {
    const f = fixture();
    const owned = acquireInstallation(f.root);
    expect(() =>
      createOperatorCliApplication(owned.capability, {
        ...f.config,
        teachers: [{ id: "../outside", root: f.config.teachers[0]?.root ?? "" }],
      }),
    ).toThrow();
    expect(nativeOpens.every((record) => record.closed)).toBe(true);
    owned.release();
  });
  it("runs the public CLI with real SQLite and refuses reserved SQLite sidecars", async () => {
    const f = fixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps = {
      acquire: acquireInstallation,
      compose: composeInstallation,
      now: () => CLI_NOW,
      stdin: new PasswordInput(),
      signals: process,
      prompt: () => undefined,
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    };
    const input = f.work("center.json", {
      centerId: "center:a",
      displayName: "Center",
      expectedVersion: null,
    });
    expect(
      await runOperatorCli(["--installation", f.root, "center", "create", "--input", input], deps),
    ).toBe(0);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      centerId: "center:a",
      displayName: "Center",
    });
    expect(stderr).toEqual([]);
    const policy = f.work("policy.json", { document: f.document });
    expect(
      await runOperatorCli(
        [
          "--installation",
          f.root,
          "policy",
          "publish",
          "--input",
          policy,
          "--output",
          `${f.databasePath}-journal`,
        ],
        deps,
      ),
    ).toBe(2);
    expect(readFileSync(f.operatorPolicyPath, "utf8")).toBe(JSON.stringify(f.document));
  });
});
