import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const removal = vi.hoisted(() => ({ skip: false, reverse: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (path: string) => {
      const names = actual.readdirSync(path);
      return removal.reverse ? names.reverse() : names;
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (!removal.skip) actual.rmSync(...args);
    },
  };
});

import {
  recoveryManifest,
  recoveryTestLimits,
  writeRecoveryArtifact,
} from "../../recovery/recovery-test-artifact.fixture.js";
import { sha256Bytes } from "../../recovery/manifest.boundary.js";
import { createBackupInventory } from "./retention-backups.boundary.js";

function backupRoot() {
  const root = mkdtempSync(join(tmpdir(), "marea-retention-backups-"));
  const backups = join(root, "backups");
  mkdirSync(backups);
  const write = (name: string, release = `release:${name}`) =>
    writeRecoveryArtifact(join(backups, name), {
      ...recoveryManifest(),
      release: { id: release, schemaVersion: 1 },
    });
  return {
    root,
    backups,
    write,
    inventory: createBackupInventory({ backupRoot: backups, limits: recoveryTestLimits }),
  };
}

describe("retention backup inventory", () => {
  it("lists verified bundles of any release in name order with their manifest identity", () => {
    const { backups, inventory, write } = backupRoot();
    expect(inventory.list()).toEqual([]);
    write("backup-b", "release:older");
    const manifest = write("backup-a");
    const bytes = readFileSync(join(backups, "backup-a", "manifest.json"));
    const digest = sha256Bytes(bytes);
    const listed = inventory.list();
    expect(listed.map((entry) => entry.name)).toEqual(["backup-a", "backup-b"]);
    removal.reverse = true;
    try {
      expect(inventory.list()).toEqual(listed);
    } finally {
      removal.reverse = false;
    }
    expect(listed[0]).toEqual({
      state: "verified",
      name: "backup-a",
      bytes: manifest.database.sizeBytes + Number(manifest.files[0]?.sizeBytes),
      target: {
        kind: "backup",
        key: { manifestDigest: digest },
        observed: {
          kind: "backup",
          manifestDigest: digest,
          databaseDigest: manifest.database.sha256,
        },
      },
    });
    expect(listed[0]).toMatchObject({ bytes: 28 });
  });

  it("marks entries that are not complete, regular bundle directories as unverifiable", () => {
    const { backups, inventory, write } = backupRoot();
    write(".hidden");
    writeFileSync(join(backups, "file"), "not a directory");
    mkdirSync(join(backups, "empty"));
    write("tampered");
    writeFileSync(join(backups, "tampered", "database.sqlite"), "changed-bytes!");
    write("no-release");
    writeFileSync(join(backups, "no-release", "manifest.json"), "{}");
    write("not-json");
    writeFileSync(join(backups, "not-json", "manifest.json"), "{");
    write("outside");
    symlinkSync(join(backups, "outside"), join(backups, "linked"));
    write("has space");
    const filesystem = "bundle-filesystem-invalid";
    const manifest = "bundle-manifest-invalid";
    expect(inventory.list()).toEqual([
      { state: "unverifiable", name: ".hidden", reason: filesystem },
      { state: "unverifiable", name: "empty", reason: manifest },
      { state: "unverifiable", name: "file", reason: filesystem },
      { state: "unverifiable", name: "has space", reason: filesystem },
      { state: "unverifiable", name: "linked", reason: filesystem },
      { state: "unverifiable", name: "no-release", reason: manifest },
      { state: "unverifiable", name: "not-json", reason: manifest },
      expect.objectContaining({ state: "verified", name: "outside" }),
      { state: "unverifiable", name: "tampered", reason: "bundle-database-invalid" },
    ]);
  });

  it("fails listing when the configured backup root cannot be read", () => {
    const { root } = backupRoot();
    const missing = createBackupInventory({
      backupRoot: join(root, "missing"),
      limits: recoveryTestLimits,
    });
    expect(() => missing.list()).toThrow();
  });

  it("disposes only bundle directories and proves they are gone", () => {
    const { backups, inventory, write } = backupRoot();
    write("backup-a");
    write("outside");
    symlinkSync(join(backups, "outside"), join(backups, "linked"));
    writeFileSync(join(backups, "file"), "x");
    inventory.dispose("backup-a");
    expect(existsSync(join(backups, "backup-a"))).toBe(false);
    for (const name of ["linked", "file", "../backups", ".hidden"])
      expect(() => {
        inventory.dispose(name);
      }).toThrow("Backup disposal target is not a bundle directory.");
    expect(() => {
      inventory.dispose("missing");
    }).toThrow();
    expect(existsSync(join(backups, "outside", "manifest.json"))).toBe(true);
    removal.skip = true;
    try {
      expect(() => {
        inventory.dispose("outside");
      }).toThrow("Backup disposal did not remove the bundle.");
    } finally {
      removal.skip = false;
    }
  });
});
