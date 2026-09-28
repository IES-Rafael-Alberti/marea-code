import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeArtifactPath, validateBundleRelativePath } from "./safe-paths.boundary.js";
import { verifyArtifactFiles } from "./artifact.boundary.js";
import { sha256Bytes } from "./manifest.boundary.js";
import type { RecoveryBundleManifest } from "./contracts.js";

// Emulate Windows path spelling without pretending this tests native ACL or filesystem behavior.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    normalize: actual.win32.normalize,
    isAbsolute: actual.win32.isAbsolute,
    dirname: (path: string) => actual.dirname(path).split(actual.sep).join("\\"),
    relative: (from: string, to: string) => actual.relative(from, to).split(actual.sep).join("\\"),
    sep: "\\",
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable recovery manifest paths", () => {
  it.each(["state/class notes.json", "state/falcon.txt", "state/lpt0.txt", "state/lpt10.txt"])(
    "preserves a portable filename that resembles a restricted spelling %j",
    (path) => {
      expect(validateBundleRelativePath(path)).toBe(path);
    },
  );

  it("accepts nested portable paths under Windows path spelling and verifies the full inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "marea-recovery-portable-"));
    roots.push(root);
    const relativePath = "state/nested/config.json";
    mkdirSync(join(root, "state/nested"), { recursive: true });
    const bytes = new TextEncoder().encode("synthetic");
    writeFileSync(join(root, relativePath), bytes);
    writeFileSync(join(root, "database.sqlite"), bytes);
    expect(validateBundleRelativePath(relativePath)).toBe(relativePath);
    expect(safeArtifactPath(root, relativePath, "bundle-filesystem-invalid")).toBe(
      join(root, relativePath),
    );
    const manifest: RecoveryBundleManifest = {
      format: "marea-recovery",
      schemaVersion: 1,
      release: { id: "synthetic", schemaVersion: 1 },
      database: {
        path: "database.sqlite",
        sha256: sha256Bytes(bytes),
        sizeBytes: bytes.length,
        format: "sqlite3",
        schemaVersion: 1,
      },
      files: [{ path: relativePath, sha256: sha256Bytes(bytes), sizeBytes: bytes.length }],
    };
    expect(
      verifyArtifactFiles(root, manifest, { fileBytes: 1024, fileCount: 3, totalBytes: 4096 }),
    ).toHaveLength(2);
  });

  it.each([
    "../escape",
    "..state/file",
    ".",
    "",
    "state/../escape",
    "state//file",
    "state\\file",
    "/absolute",
    "C:/file",
    "state/file:stream",
    "state/NUL",
    "state/COM1.txt",
    "state/LPT1.txt",
    "state/file.",
    "state/file ",
    "state/a?b",
    "state/a\u0000b",
  ])("rejects alias or nonportable path %j", (path) => {
    expect(() => validateBundleRelativePath(path)).toThrow();
  });
});
