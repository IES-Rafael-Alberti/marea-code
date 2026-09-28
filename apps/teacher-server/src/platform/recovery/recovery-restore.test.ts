import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createRecoveryBundle, restoreRecoveryBundle } from "./index.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
import { restoreSchemas } from "./recovery-sqlite-mocks.fixture.js";
import { recoveryInput } from "./recovery-test-state.fixture.js";

vi.mock("@marea/sqlite-storage", async () => {
  const fixture = await import("./recovery-sqlite-mocks.fixture.js");
  return fixture.default;
});

const environment = startRecoveryTest("marea-recovery-restore-");
const root = environment.root;
const writeState = environment.writeState;
const input = () => recoveryInput(root());

describe("recovery bundle restore", () => {
  it("restores and reopens with the destination installation's schema catalog", () => {
    writeState();
    const bundle = createRecoveryBundle(join(root(), "catalog"), input());
    const before = restoreSchemas().length;
    for (const [name, options] of [
      ["catalog-default", {}],
      ["catalog-audit", { schema: "retention-audit" as const }],
    ] as const)
      restoreRecoveryBundle(
        { destinationRoot: join(root(), name), path: bundle.path, ...options },
        { id: "release:one", schemaVersion: 1 },
        { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
      ).close();
    expect(restoreSchemas().slice(before)).toEqual([
      "application",
      "application",
      "retention-audit",
      "retention-audit",
    ]);
  });

  it("rejects an artifact database whose bytes changed after capture", () => {
    writeState();
    const bundle = createRecoveryBundle(join(root(), "changed-database"), input());
    writeFileSync(join(bundle.path, "database.sqlite"), "changed");
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { destinationRoot: join(root(), "changed-database-restore"), path: bundle.path },
          { id: "release:one", schemaVersion: 1 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        ),
      "bundle-database-invalid",
    );
  });

  it("rejects a restore release mismatch and destination collision", () => {
    writeState();
    const bundle = createRecoveryBundle(join(root(), "bundle"), input());
    mkdirSync(join(root(), "destination"));
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { destinationRoot: join(root(), "destination"), path: bundle.path },
          { id: "release:one", schemaVersion: 1 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        ),
      "bundle-destination-invalid",
    );
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { destinationRoot: join(root(), "destination"), path: bundle.path },
          { id: "release:other", schemaVersion: 1 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        ),
      "bundle-destination-invalid",
    );
    rmSync(join(root(), "destination"), { recursive: true });
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { destinationRoot: join(root(), "destination"), path: bundle.path },
          { id: "release:two", schemaVersion: 1 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        ),
      "bundle-manifest-invalid",
    );
    expect(existsSync(join(root(), "destination"))).toBe(false);
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { destinationRoot: join(root(), "invalid-release"), path: bundle.path },
          { id: "release:one", schemaVersion: 0 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        ),
      "bundle-input-invalid",
    );
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { destinationRoot: join(root(), "empty-id"), path: bundle.path },
          { id: "", schemaVersion: 1 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        ),
      "bundle-input-invalid",
    );
  });

  it("reports migration and release-schema failures without publishing a destination", () => {
    writeState();
    const bundle = createRecoveryBundle(join(root(), "bundle"), input());
    const manifestPath = join(root(), "bundle/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath).toString()) as {
      database: { schemaVersion: number };
      release: { schemaVersion: number };
    };
    manifest.release.schemaVersion = 3;
    manifest.database.schemaVersion = 3;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const restore = (schemaVersion: number) =>
      restoreRecoveryBundle(
        { destinationRoot: join(root(), "destination"), path: bundle.path },
        { id: "release:one", schemaVersion },
        { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
      );
    expectRecoveryError(() => restore(3), "bundle-database-invalid");
    expectRecoveryError(() => restore(1), "bundle-manifest-invalid");
    expect(existsSync(join(root(), "destination"))).toBe(false);
    expect(readdirSync(root()).filter((entry) => entry.includes(".marea-recovery."))).toEqual([]);
  });

  it("removes a published destination when the final database cannot be reopened", () => {
    writeState();
    const bundle = createRecoveryBundle(join(root(), "bundle"), input());
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { destinationRoot: join(root(), "reopen-failure"), path: bundle.path },
          { id: "release:one", schemaVersion: 1 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        ),
      "bundle-restore-failed",
    );
    expect(existsSync(join(root(), "reopen-failure"))).toBe(false);
  });

  it("rejects a database that changed after manifest verification", () => {
    writeState();
    const bundle = createRecoveryBundle(join(root(), "bundle"), input());
    const manifestPath = join(bundle.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath).toString()) as {
      database: { sha256: string };
    };
    manifest.database.sha256 = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expectRecoveryError(
      () =>
        restoreRecoveryBundle(
          { destinationRoot: join(root(), "changed-database"), path: bundle.path },
          { id: "release:one", schemaVersion: 1 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        ),
      "bundle-database-invalid",
    );
  });
});
