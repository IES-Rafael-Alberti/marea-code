import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { publishArtifactDirectory } from "./artifact.boundary.js";
import { restoreRecoveryBundle } from "./index.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
import { recoveryTestLimits, writeRecoveryArtifact } from "./recovery-test-artifact.fixture.js";

vi.mock("@marea/sqlite-storage", async () => {
  const fixture = await import("./recovery-sqlite-mocks.fixture.js");
  return fixture.default;
});

const state = { corruptCopy: false };
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof writeFileSync>) => {
      actual.writeFileSync(...args);
      if (state.corruptCopy) actual.writeFileSync(args[0], "corrupted");
    },
  };
});

const environment = startRecoveryTest("marea-recovery-publication-");
const root = environment.root;

describe("recovery publication boundaries", () => {
  it("removes staging when destination stat fails", () => {
    const staged = join(root(), "invalid-destination-stat-staged");
    mkdirSync(staged);
    writeFileSync(join(staged, "owned"), "owned");
    expectRecoveryError(() => {
      publishArtifactDirectory(staged, `${root()}\0destination`);
    }, "bundle-filesystem-invalid");
    expect(existsSync(staged)).toBe(false);
  });

  it("cleans owned staging when publication is rejected", () => {
    for (const [name, existing] of [
      ["destination-exists", true],
      ["parent-invalid", false],
    ] as const) {
      const staged = join(root(), `cleanup-${name}`);
      mkdirSync(staged);
      writeFileSync(join(staged, "owned"), "owned");
      let destination = join(root(), `cleanup-${name}-destination`);
      if (existing) {
        mkdirSync(destination);
        writeFileSync(join(destination, "sentinel"), "preserve");
      } else {
        const parent = join(root(), `cleanup-${name}-parent`);
        writeFileSync(parent, "parent");
        destination = join(destination, "child");
      }
      expectRecoveryError(
        () => {
          publishArtifactDirectory(staged, destination);
        },
        existing ? "bundle-destination-invalid" : "bundle-filesystem-invalid",
      );
      expect(existsSync(staged)).toBe(false);
    }

    const invalidByteStaged = join(root(), "invalid-byte-staged");
    mkdirSync(invalidByteStaged);
    expectRecoveryError(() => {
      publishArtifactDirectory(invalidByteStaged, `${root()}\0destination`);
    }, "bundle-filesystem-invalid");
    expect(existsSync(invalidByteStaged)).toBe(false);
  });

  it("verifies bytes copied into restore staging", () => {
    writeRecoveryArtifact(join(root(), "copy-source"));
    state.corruptCopy = true;
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { path: join(root(), "copy-source"), destinationRoot: join(root(), "copy-destination") },
          { id: "release:one", schemaVersion: 1 },
          recoveryTestLimits,
        ),
      "bundle-filesystem-invalid",
    );
    state.corruptCopy = false;
    expect(existsSync(join(root(), "copy-destination"))).toBe(false);
  });
});
