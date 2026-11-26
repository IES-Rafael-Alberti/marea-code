import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const descriptors = vi.hoisted(() => ({ opened: 0, closed: 0, synced: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((...parameters: Parameters<typeof actual.openSync>) => {
      descriptors.opened += 1;
      return actual.openSync(...parameters);
    }) as typeof actual.openSync,
    closeSync: (descriptor: number) => {
      descriptors.closed += 1;
      actual.closeSync(descriptor);
    },
    fsyncSync: (descriptor: number) => {
      descriptors.synced += 1;
      actual.fsyncSync(descriptor);
    },
  };
});

import { backupFileCopier } from "./backup-file.boundary.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "marea-sqlite-copier-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("backup file copying", () => {
  it("copies a file larger than one read chunk privately after checking its digest", () => {
    const directory = createTemporaryDirectory();
    const source = join(directory, "source.sqlite");
    const destination = join(directory, "restored.sqlite");
    const bytes = new Uint8Array(2_500_000).map((_value, index) => index % 251);
    writeFileSync(source, bytes);
    let stagedPath = "";

    backupFileCopier.installFile(destination, source, digest(bytes), (candidate) => {
      stagedPath = candidate;
      expect(existsSync(destination)).toBe(false);
      expect(statSync(candidate).mode & 0o777).toBe(0o600);
    });

    expect(readFileSync(destination).equals(Buffer.from(bytes))).toBe(true);
    expect(existsSync(stagedPath)).toBe(false);
  });

  it("flushes the staged copy and releases its descriptor, also when the digest differs", () => {
    const directory = createTemporaryDirectory();
    const source = join(directory, "source.sqlite");
    writeFileSync(source, "synthetic");
    descriptors.opened = descriptors.closed = descriptors.synced = 0;
    backupFileCopier.installFile(
      join(directory, "ok.sqlite"),
      source,
      digest(Buffer.from("synthetic")),
      () => undefined,
    );
    expect(descriptors).toEqual({ opened: 1, closed: 1, synced: 1 });
    expect(() => {
      backupFileCopier.installFile(
        join(directory, "bad.sqlite"),
        source,
        "0".repeat(64),
        () => undefined,
      );
    }).toThrow();
    expect(descriptors.opened).toBe(descriptors.closed);
  });

  it("rejects a copy whose digest differs and leaves nothing behind", () => {
    const directory = createTemporaryDirectory();
    const source = join(directory, "source.sqlite");
    const destination = join(directory, "restored.sqlite");
    writeFileSync(source, "synthetic");
    let validated = false;

    expect(() => {
      backupFileCopier.installFile(destination, source, "0".repeat(64), () => {
        validated = true;
      });
    }).toThrow(
      expect.objectContaining({
        code: "backup-invalid",
        message: "The SQLite backup is invalid.",
      }),
    );

    expect(validated).toBe(false);
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(directory)).toEqual(["source.sqlite"]);
  });

  it("never overwrites an existing destination and removes staging when validation fails", () => {
    const directory = createTemporaryDirectory();
    const source = join(directory, "source.sqlite");
    const destination = join(directory, "restored.sqlite");
    writeFileSync(source, "synthetic");
    writeFileSync(destination, "original");

    expect(() => {
      backupFileCopier.installFile(
        destination,
        source,
        digest(Buffer.from("synthetic")),
        () => undefined,
      );
    }).toThrow();
    expect(readFileSync(destination, "utf8")).toBe("original");

    rmSync(destination);
    expect(() => {
      backupFileCopier.installFile(destination, source, digest(Buffer.from("synthetic")), () => {
        throw new Error("rejected");
      });
    }).toThrow("rejected");
    expect(readdirSync(directory)).toEqual(["source.sqlite"]);
  });

  it("fails when the source file is missing", () => {
    const directory = createTemporaryDirectory();
    expect(() => {
      backupFileCopier.installFile(
        join(directory, "restored.sqlite"),
        join(directory, "missing.sqlite"),
        "0".repeat(64),
        () => undefined,
      );
    }).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});
