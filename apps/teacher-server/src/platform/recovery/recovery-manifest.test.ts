import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RECOVERY_BUNDLE_FORMAT,
  RECOVERY_BUNDLE_SCHEMA_VERSION,
  RecoveryBundleError,
} from "./contracts.js";
import { parseManifest, serializeManifest, sha256Bytes } from "./manifest.boundary.js";
import { verifyArtifactManifest } from "./artifact.boundary.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
import { recoveryManifest, recoveryTestLimits } from "./recovery-test-artifact.fixture.js";

const environment = startRecoveryTest("marea-recovery-manifest-");
const root = environment.root;
const limits = recoveryTestLimits;
const fileBytes = new TextEncoder().encode("required-bytes");
const manifest = () => recoveryManifest();

function expectManifestJsonInvalid(): void {
  let error: unknown;
  try {
    parseManifest(new TextEncoder().encode("{"), "release:one");
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RecoveryBundleError);
  expect(error).toMatchObject({
    code: "bundle-manifest-invalid",
    message: "manifest JSON is invalid",
  });
}

describe("recovery bundle manifests", () => {
  it("enforces strict manifest records and UTF-8", () => {
    const value = manifest();
    const bytes = serializeManifest(value);
    expect(parseManifest(bytes, "release:one")).toEqual(value);
    const encoded = JSON.stringify({
      database: value.database,
      files: value.files,
      format: RECOVERY_BUNDLE_FORMAT,
      release: value.release,
      schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
    });
    expectManifestJsonInvalid();
    expectRecoveryError(
      () => parseManifest(new TextEncoder().encode(encoded), "release:other"),
      "bundle-manifest-invalid",
    );
    expectRecoveryError(
      () =>
        parseManifest(
          serializeManifest({
            ...value,
            files: [{ path: "state/file\u{FFFD}", sha256: sha256Bytes(fileBytes), sizeBytes: 14 }],
          }),
          "release:one",
        ),
      "bundle-manifest-invalid",
    );
    const invalid: readonly string[] = [
      JSON.stringify(null),
      JSON.stringify([]),
      "{}",
      JSON.stringify({ ...JSON.parse(encoded), database: undefined }),
      JSON.stringify({ ...JSON.parse(encoded), format: "other" }),
      JSON.stringify({ ...JSON.parse(encoded), files: undefined }),
      JSON.stringify({ ...JSON.parse(encoded), release: undefined }),
      JSON.stringify({ ...JSON.parse(encoded), schemaVersion: 0 }),
      JSON.stringify({
        ...JSON.parse(encoded),
        release: { ...value.release, id: "release:other" },
      }),
      JSON.stringify({ ...JSON.parse(encoded), release: { ...value.release, schemaVersion: 0 } }),
      JSON.stringify({
        ...JSON.parse(encoded),
        release: { ...value.release, schemaVersion: Number.MAX_SAFE_INTEGER + 1 },
      }),
      JSON.stringify({ ...JSON.parse(encoded), release: { id: 1, schemaVersion: 1 } }),
      JSON.stringify({ ...JSON.parse(encoded), unknown: "extra" }),
      JSON.stringify({
        ...JSON.parse(encoded),
        release: { ...value.release, unknown: "extra" },
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        database: { ...value.database, unknown: "extra" },
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        files: [{ ...value.files[0], unknown: "extra" }],
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        files: [{ ...value.files[0], sizeBytes: "0" }],
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        files: [{ ...value.files[0], sizeBytes: -1 }],
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        database: { ...value.database, format: "not-sqlite" },
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        release: { ...value.release, schemaVersion: 2 },
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        files: [{ ...value.files[0], path: "manifest.json" }],
      }),
      JSON.stringify({ ...JSON.parse(encoded), database: { ...value.database, path: "other" } }),
      JSON.stringify({ ...JSON.parse(encoded), database: { ...value.database, path: 1 } }),
      JSON.stringify({ ...JSON.parse(encoded), database: { ...value.database, sha256: "short" } }),
      JSON.stringify({
        ...JSON.parse(encoded),
        database: { ...value.database, sha256: "g".repeat(64) },
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        database: { ...value.database, sha256: "0".repeat(63) },
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        database: { ...value.database, sha256: `g${"0".repeat(63)}` },
      }),
      JSON.stringify({
        ...JSON.parse(encoded),
        database: { ...value.database, sha256: `${"a".repeat(63)}0g` },
      }),
      JSON.stringify({ ...JSON.parse(encoded), database: { ...value.database, sizeBytes: 0 } }),
      JSON.stringify({ ...JSON.parse(encoded), database: { ...value.database, sizeBytes: 1.5 } }),
      JSON.stringify({ ...JSON.parse(encoded), files: "array" }),
      JSON.stringify({ ...JSON.parse(encoded), files: ["entry"] }),
      JSON.stringify({ ...JSON.parse(encoded), files: [{ ...value.files[0], path: 1 }] }),
      JSON.stringify({
        ...JSON.parse(encoded),
        files: [
          value.files[0],
          { path: "state/file", sha256: sha256Bytes(fileBytes), sizeBytes: 14 },
        ],
      }),
    ];
    for (const item of invalid)
      expectRecoveryError(
        () => parseManifest(new TextEncoder().encode(item), "release:one"),
        "bundle-manifest-invalid",
      );
    let oversizedError: unknown;
    try {
      parseManifest(new TextEncoder().encode("x".repeat(65)), "release:one");
    } catch (error) {
      oversizedError = error;
    }
    expect(oversizedError).toMatchObject({
      code: "bundle-manifest-invalid",
      message: "manifest JSON is invalid",
    });
    expectRecoveryError(
      () => parseManifest(new TextEncoder().encode('{"database":1}'), "release:one"),
      "bundle-manifest-invalid",
    );
    const replacementBytes = new TextEncoder().encode(
      JSON.stringify({ ...JSON.parse(encoded), unknown: "a" }),
    );
    replacementBytes[replacementBytes.length - 3] = 0xff;
    expectRecoveryError(
      () => parseManifest(replacementBytes, "release:one"),
      "bundle-manifest-invalid",
    );
    expectRecoveryError(
      () => parseManifest(new Uint8Array([0x80]), "release:one"),
      "bundle-manifest-invalid",
    );
    const manifestWithPlaceholder = new TextEncoder().encode(
      JSON.stringify({
        ...value,
        files: [{ path: "PLACEHOLDER", sha256: sha256Bytes(fileBytes), sizeBytes: 14 }],
      }),
    );
    const placeholder = new TextEncoder().encode("PLACEHOLDER");
    const placeholderIndex = Buffer.from(manifestWithPlaceholder).indexOf(Buffer.from(placeholder));
    const invalidUtf8Json = Uint8Array.from([
      ...manifestWithPlaceholder.subarray(0, placeholderIndex),
      ...new TextEncoder().encode("state/file"),
      0x80,
      ...manifestWithPlaceholder.subarray(placeholderIndex + placeholder.byteLength),
    ]);
    expectRecoveryError(
      () => parseManifest(invalidUtf8Json, "release:one"),
      "bundle-manifest-invalid",
    );
    expectRecoveryError(
      () =>
        parseManifest(
          serializeManifest({
            ...value,
            files: [
              ...value.files,
              { path: "database.sqlite", sha256: "0".repeat(64), sizeBytes: 1 },
              { path: "database.sqlite", sha256: "0".repeat(64), sizeBytes: 1 },
            ],
          }),
          "release:one",
        ),
      "bundle-manifest-invalid",
    );
    const traversalRoot = join(root(), "traversal-manifest");
    mkdirSync(traversalRoot, { recursive: true });
    writeFileSync(
      join(traversalRoot, "manifest.json"),
      JSON.stringify({
        ...JSON.parse(encoded),
        files: [{ path: "../escape", sha256: sha256Bytes(fileBytes), sizeBytes: 14 }],
      }),
    );
    expectRecoveryError(
      () => verifyArtifactManifest(traversalRoot, limits, "release:one"),
      "bundle-input-invalid",
    );
    const linkedManifestRoot = join(root(), "linked-manifest");
    mkdirSync(join(linkedManifestRoot, "state"), { recursive: true });
    writeFileSync(join(linkedManifestRoot, "state/valid.json"), serializeManifest(manifest()));
    linkSync(
      join(linkedManifestRoot, "state/valid.json"),
      join(linkedManifestRoot, "manifest.json"),
    );
    expectRecoveryError(
      () => verifyArtifactManifest(linkedManifestRoot, limits, "release:one"),
      "bundle-manifest-invalid",
    );
    const symbolicManifestRoot = join(root(), "symbolic-manifest");
    mkdirSync(join(symbolicManifestRoot, "state"), { recursive: true });
    writeFileSync(join(symbolicManifestRoot, "state/valid.json"), serializeManifest(manifest()));
    symlinkSync("state/valid.json", join(symbolicManifestRoot, "manifest.json"));
    expectRecoveryError(
      () => verifyArtifactManifest(symbolicManifestRoot, limits, "release:one"),
      "bundle-manifest-invalid",
    );
  });

  it("rejects invalid UTF-8 and validates manifest JSON parsing", () => {
    expectRecoveryError(
      () => parseManifest(new Uint8Array([0x80]), "release:one"),
      "bundle-manifest-invalid",
    );
    expectManifestJsonInvalid();
  });
});
