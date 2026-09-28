import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../retention/retention-bun-sqlite.fixture.js"));

import type { RecoveryBundleInput } from "../../recovery/contracts.js";
import { writeRecoveryArtifact } from "../../recovery/recovery-test-artifact.fixture.js";
import { createBackupInventory } from "../retention/retention-backups.boundary.js";
import { createRetentionService } from "../retention/retention-service.js";
import { NOW, retentionHarness } from "../retention/retention.fixture.js";
import { AuthorityLineageSchema, type TargetRef } from "../schemas.js";
import { createSqliteDeletionIndex } from "../storage/sqlite-deletion-index.js";
import { targetIdentity } from "../validators.js";
import { readAuthorityRecord } from "./authority-record.boundary.js";
import { createAuthorizedRecoveryBundle } from "./authorized-backup.js";
import { reconcileRestoredBundle } from "./restore-reconciliation.js";

const RECORD = "deletion-authority.json";
const LIMITS = { fileBytes: 4_096, fileCount: 4, totalBytes: 16_384 } as const;
const DATABASE_BYTES = new TextEncoder().encode("synthetic-sqlite");

type Harness = ReturnType<typeof retentionHarness>;

function bundleInput(
  h: Harness,
  createBackup = () => DATABASE_BYTES,
): Omit<RecoveryBundleInput, "createExclusive"> {
  return {
    sourceRoot: h.root,
    files: [],
    limits: LIMITS,
    release: { id: "release:one", schemaVersion: 1 },
    createBackup: {
      createBackup: () => {
        const bytes = createBackup();
        return {
          bytes,
          format: "sqlite3",
          schemaVersion: 1,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    },
  };
}

function authorizedBundle(h: Harness, destinationPath: string, drains: unknown[] = []) {
  return createAuthorizedRecoveryBundle({
    coordinator: {
      preview: (operation) => h.dependencies.coordinator.preview(operation),
      run: (input, operation) => {
        drains.push(input);
        return h.dependencies.coordinator.run(input, operation);
      },
    },
    index: h.index,
    drainUntil: NOW,
    destinationPath,
    bundle: bundleInput(h),
  });
}

function reconcile(
  h: Harness,
  bundlePath: string,
  restored = retentionHarness().database,
  authorityLineage: string = h.configuration.authorityLineage,
) {
  return reconcileRestoredBundle({
    bundlePath,
    limits: LIMITS,
    restored,
    destination: { authorityLineage, rootId: h.configuration.rootId },
    indexFor: (reader) => createSqliteDeletionIndex(h.indexDatabase, h.configuration, reader),
  });
}

function offsite(h: Harness, name: string): string {
  mkdirSync(join(h.root, "offsite"), { recursive: true });
  return join(h.root, "offsite", name);
}

describe("restore deletion authority", () => {
  it("captures the current authority inside the backup's exclusive run", async () => {
    const h = retentionHarness();
    const drains: unknown[] = [];
    const bundle = await authorizedBundle(h, offsite(h, "bundle-a"), drains);
    expect(drains).toEqual([{ drainUntil: NOW }]);
    expect(bundle.manifest.files.map((file) => file.path)).toEqual([RECORD]);
    expect(readAuthorityRecord(bundle.path, bundle.manifest)).toEqual({
      format: "marea-deletion-authority:1",
      authorityLineage: h.configuration.authorityLineage,
      rootId: h.configuration.rootId,
      indexGeneration: 0,
      databaseLineage: h.configuration.databaseLineage,
    });
    expect(existsSync(join(h.root, RECORD))).toBe(false);

    const failing = createAuthorizedRecoveryBundle({
      coordinator: h.dependencies.coordinator,
      index: h.index,
      drainUntil: NOW,
      destinationPath: offsite(h, "bundle-failed"),
      bundle: bundleInput(h, () => {
        throw new Error("backup failed");
      }),
    });
    await expect(failing).rejects.toMatchObject({ code: "bundle-database-invalid" });
    expect(existsSync(join(h.root, RECORD))).toBe(false);
  });

  it("refuses to capture authority while a deletion is pending or the index is not active", async () => {
    const h = retentionHarness();
    const inactive = createAuthorizedRecoveryBundle({
      coordinator: h.dependencies.coordinator,
      index: { inspect: async () => ({ ...(await h.index.inspect()), state: "retired" }) },
      drainUntil: NOW,
      destinationPath: offsite(h, "bundle-retired"),
      bundle: bundleInput(h),
    });
    await expect(inactive).rejects.toMatchObject({
      code: "uncertain",
      message: "The deletion index is not ready for a backup.",
    });
    await h.index.prepare({
      operationId: "operation:pending",
      authorityLineage: h.configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [h.observe("run", "run:closed")],
      artifactDigest: h.configuration.databaseLineage,
    });
    await expect(authorizedBundle(h, offsite(h, "bundle-pending"))).rejects.toMatchObject({
      message: "The deletion index is not ready for a backup.",
    });
    expect(existsSync(offsite(h, "bundle-pending"))).toBe(false);
    expect(existsSync(join(h.root, RECORD))).toBe(false);
  });

  it("verifies an isolated restore that descends from the current authority", async () => {
    const h = retentionHarness();
    const bundle = await authorizedBundle(h, offsite(h, "bundle-a"));
    expect(await reconcile(h, bundle.path)).toEqual({
      state: "verified",
      currentIndexGeneration: 0,
      checked: 11,
      tombstoned: [],
      reasonCode: "none",
    });
  });

  it("blocks a restore that would resurrect deleted runs, accounts and the bundle itself", async () => {
    const h = retentionHarness();
    const backups = createBackupInventory({ backupRoot: h.backupRoot, limits: LIMITS });
    const service = createRetentionService({ ...h.dependencies, backups });
    const bundle = await authorizedBundle(h, join(h.backupRoot, "bundle-a"));
    const copy = offsite(h, "bundle-a-copy");
    cpSync(bundle.path, copy, { recursive: true });
    const [inventoried] = backups.list();
    if (inventoried?.state !== "verified") throw new Error("The bundle must verify.");
    const artifact = await service.preview(
      h.request([h.observe("account", "student:one"), inventoried.target]),
    );
    expect(artifact.blockers).toEqual([]);
    expect(await service.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "applied",
    });

    const result = await reconcile(h, copy);
    expect(result).toMatchObject({
      state: "blocked",
      currentIndexGeneration: 1,
      checked: 11,
      reasonCode: "tombstoned-identity",
    });
    const deleted = (targets: readonly TargetRef[]) => targets.map(targetIdentity).sort();
    expect(deleted(result.tombstoned)).toEqual(deleted(artifact.targets));

    const after = await authorizedBundle(h, offsite(h, "bundle-after"));
    expect(await reconcile(h, after.path, h.database)).toMatchObject({
      state: "verified",
      currentIndexGeneration: 1,
      checked: 5,
    });
    expect(
      await reconcile(h, after.path, h.database, AuthorityLineageSchema.parse("lineage:other")),
    ).toMatchObject({ state: "blocked", reasonCode: "lineage-conflict" });
    const behind = retentionHarness();
    expect(await reconcile(behind, after.path, h.database)).toMatchObject({
      state: "blocked",
      currentIndexGeneration: 0,
      reasonCode: "stale-generation",
    });
  });

  it("treats bundles without authority as unknown ancestry and rejects tampered records", async () => {
    const h = retentionHarness();
    const plain = offsite(h, "bundle-plain");
    writeRecoveryArtifact(plain);
    expect(await reconcile(h, plain)).toEqual({
      state: "blocked",
      currentIndexGeneration: 0,
      checked: 0,
      tombstoned: [],
      reasonCode: "unknown-ancestry",
    });

    const bundle = await authorizedBundle(h, offsite(h, "bundle-a"));
    const recordPath = join(bundle.path, RECORD);
    const original = readFileSync(recordPath, "utf8");
    writeFileSync(recordPath, original.replace('"indexGeneration":0', '"indexGeneration":9'));
    expect(() => readAuthorityRecord(bundle.path, bundle.manifest)).toThrow(
      expect.objectContaining({ code: "bundle-filesystem-invalid" }),
    );
    writeFileSync(recordPath, `${original} `);
    expect(() => readAuthorityRecord(bundle.path, bundle.manifest)).toThrow(
      expect.objectContaining({ code: "bundle-filesystem-invalid" }),
    );
    await expect(reconcile(h, bundle.path)).rejects.toMatchObject({
      code: "bundle-filesystem-invalid",
    });
  });
});
