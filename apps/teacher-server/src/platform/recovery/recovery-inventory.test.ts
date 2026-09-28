import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const inventory = { closed: 0 };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    actualFs: actual,
    opendirSync: (path: string, options?: Parameters<typeof actual.opendirSync>[1]) => {
      if (path.endsWith("unreadable")) throw new Error("directory unavailable");
      const descriptor = actual.opendirSync(path, options);
      const originalClose = descriptor.closeSync.bind(descriptor);
      return Object.assign(descriptor, {
        closeSync: () => {
          inventory.closed += 1;
          originalClose();
        },
      });
    },
  };
});

import { verifyArtifactFiles } from "./artifact.boundary.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
import {
  recoveryManifest,
  recoveryTestLimits,
  writeRecoveryArtifact,
} from "./recovery-test-artifact.fixture.js";

const environment = startRecoveryTest("marea-recovery-inventory-");
const root = environment.root;

describe("recovery artifact inventory traversal", () => {
  it("maps directory traversal failures to filesystem errors", () => {
    const artifact = join(root(), "unreadable");
    writeRecoveryArtifact(artifact);
    const nested = join(artifact, "unreadable");
    mkdirSync(nested);
    writeFileSync(join(nested, "state"), "bytes");
    const manifest = {
      ...recoveryManifest(),
      files: [
        ...recoveryManifest().files,
        { path: "unreadable/state", sha256: "0".repeat(64), sizeBytes: 5 },
      ],
    };
    writeFileSync(join(artifact, "manifest.json"), JSON.stringify(manifest));
    expectRecoveryError(
      () => verifyArtifactFiles(artifact, manifest, recoveryTestLimits),
      "bundle-filesystem-invalid",
    );
    expect(inventory.closed).toBe(0);
    inventory.closed = 0;
    const successful = join(root(), "successful-inventory");
    writeRecoveryArtifact(successful);
    verifyArtifactFiles(successful, recoveryManifest(), recoveryTestLimits);
    expect(inventory.closed).toBe(2);
    inventory.closed = 0;
  });

  it("rejects file-shaped directories and inventory budget overflow", async () => {
    const fileDirectory = join(root(), "file-directory");
    writeRecoveryArtifact(fileDirectory);
    rmSync(join(fileDirectory, "state"), { recursive: true });
    writeFileSync(join(fileDirectory, "state"), "unexpected regular directory");
    expectRecoveryError(
      () => verifyArtifactFiles(fileDirectory, recoveryManifest(), recoveryTestLimits),
      "bundle-filesystem-invalid",
    );

    const budget = join(root(), "budget");
    const manifest = writeRecoveryArtifact(budget);
    expectRecoveryError(
      () => verifyArtifactFiles(budget, manifest, { ...recoveryTestLimits, fileCount: 0 }),
      "bundle-manifest-invalid",
    );

    const manifestDirectory = join(root(), "manifest-directory");
    writeRecoveryArtifact(manifestDirectory);
    rmSync(join(manifestDirectory, "manifest.json"));
    mkdirSync(join(manifestDirectory, "manifest.json"));
    expectRecoveryError(
      () => verifyArtifactFiles(manifestDirectory, recoveryManifest(), recoveryTestLimits),
      "bundle-manifest-invalid",
    );

    const manifestLink = join(root(), "manifest-link");
    writeRecoveryArtifact(manifestLink);
    rmSync(join(manifestLink, "manifest.json"));
    symlinkSync(join(manifestLink, "state/file"), join(manifestLink, "manifest.json"));
    expectRecoveryError(
      () => verifyArtifactFiles(manifestLink, recoveryManifest(), recoveryTestLimits),
      "bundle-manifest-invalid",
    );

    const manifestHardLink = join(root(), "manifest-hard-link");
    writeRecoveryArtifact(manifestHardLink);
    const outside = join(root(), "manifest-hard-link-copy");
    rmSync(outside, { force: true });
    linkSync(join(manifestHardLink, "manifest.json"), outside);
    expectRecoveryError(
      () => verifyArtifactFiles(manifestHardLink, recoveryManifest(), recoveryTestLimits),
      "bundle-manifest-invalid",
    );

    const linkedDirectory = join(root(), "linked-directory");
    const linkedTarget = join(root(), "linked-directory-target");
    const actualFs = (
      (await import("node:fs")) as unknown as typeof import("node:fs") & {
        actualFs: typeof import("node:fs");
      }
    ).actualFs;
    actualFs.mkdirSync(linkedTarget);
    actualFs.writeFileSync(join(linkedTarget, "file"), "required-bytes");
    actualFs.mkdirSync(linkedDirectory);
    actualFs.writeFileSync(join(linkedDirectory, "database.sqlite"), "database-bytes");
    actualFs.writeFileSync(
      join(linkedDirectory, "manifest.json"),
      JSON.stringify(recoveryManifest()),
    );
    symlinkSync(linkedTarget, join(linkedDirectory, "state"));
    expectRecoveryError(
      () => verifyArtifactFiles(linkedDirectory, recoveryManifest(), recoveryTestLimits),
      "bundle-filesystem-invalid",
    );
  });
});
