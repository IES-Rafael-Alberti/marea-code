import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../retention/retention-bun-sqlite.fixture.js"));

import { createRetentionService } from "../retention/retention-service.js";
import { NOW, rowCount } from "../retention/retention.fixture.js";
import { targetIdentity } from "../validators.js";
import { createDeletionRecoveryService } from "./deletion-recovery.js";
import {
  RECOVERED_AT,
  recoveryHarness,
  type RecoveryHarness,
} from "./deletion-recovery.fixture.js";

async function previewRun(h: RecoveryHarness, previewId = "preview:one") {
  return h.service.preview(h.request([h.observe("run", "run:closed")], previewId));
}

async function expectApplied(h: RecoveryHarness, previewId = "preview:one") {
  expect(await h.index.inspect()).toMatchObject({ generation: 1, pendingCheckpoint: null });
  expect(h.audit().read(previewId)).toMatchObject({ state: "applied" });
  expect(rowCount(h.database, "marea_runs", "id = 'run:closed'")).toBe(0);
  expect(rowCount(h.database, "marea_run_snapshots", "id = 'snapshot:own'")).toBe(0);
  expect(await h.recovery.inspect()).toEqual({
    state: "none",
    operationId: null,
    checkpoint: null,
    reasonCode: "idle",
  });
  expect(await h.recovery.inspect(previewId)).toEqual({
    state: "applied",
    operationId: previewId,
    checkpoint: null,
    reasonCode: "audit-record",
  });
}

const APPLIED = { state: "applied", checkpoint: null, reasonCode: "applied" } as const;

describe("deletion recovery continuation", () => {
  it("finishes an uncertain confirmation, disposing its backups exactly once", async () => {
    const h = recoveryHarness();
    h.writeBackup("backup-a");
    const [backup] = h.backups.list();
    if (backup?.state !== "verified") throw new Error("The fixture backup must verify.");
    const failing = createRetentionService({
      ...h.dependencies,
      backups: {
        list: () => h.backups.list(),
        dispose: () => {
          throw new Error("disk failure");
        },
      },
    });
    const artifact = await failing.preview(
      h.request([h.observe("run", "run:closed"), backup.target]),
    );
    expect(await failing.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "uncertain",
    });
    expect(await h.recovery.inspect()).toMatchObject({
      state: "uncertain",
      operationId: "preview:one",
      checkpoint: { state: "uncertain", contentState: "in-progress" },
      reasonCode: "pending-checkpoint",
    });
    expect(await h.recovery.inspect("preview:one")).toMatchObject({ state: "uncertain" });

    expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject({
      ...APPLIED,
      operationId: "preview:one",
    });
    expect(existsSync(join(h.backupRoot, "backup-a"))).toBe(false);
    await expectApplied(h);
    const dispositions = h.dependencies.auditFor(h.database).dispositions.list("preview:one");
    expect(dispositions.map((entry) => [entry.logicalKey, entry.disposition])).toEqual(
      expect.arrayContaining(artifact.targets.map((target) => [targetIdentity(target), "deleted"])),
    );
    expect(dispositions).toHaveLength(artifact.targets.length);
    for (const target of artifact.targets)
      expect(await h.index.assertCreatable(target)).toEqual({ allowed: false, code: "tombstoned" });
    expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject(APPLIED);
  });

  it("keeps dispositions recorded before the index could complete", async () => {
    const h = recoveryHarness();
    const failing = createRetentionService({
      ...h.dependencies,
      index: { ...h.index, completeContent: () => Promise.reject(new Error("index failure")) },
    });
    const artifact = await failing.preview(h.request([h.observe("run", "run:closed")]));
    expect(await failing.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "uncertain",
    });
    const recorded = h.dependencies.auditFor(h.database).dispositions.list("preview:one");
    expect(recorded.map((entry) => entry.disposition)).toEqual(["deleted", "deleted"]);
    expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject(APPLIED);
    expect(h.dependencies.auditFor(h.database).dispositions.list("preview:one")).toEqual(recorded);
    await expectApplied(h);
  });

  it("continues from every crash point after tombstones were committed", async () => {
    for (const stage of ["index-committed", "content-started"] as const) {
      const h = recoveryHarness();
      const artifact = await previewRun(h);
      await h.interruptAt(artifact, stage);
      expect(await h.recovery.inspect()).toMatchObject({
        state: "index-committed",
        reasonCode: "pending-checkpoint",
      });
      expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject(APPLIED);
      await expectApplied(h);
    }
  });

  it("completes an audit that fell behind a completed index", async () => {
    for (const auditState of ["content-started", "content-complete"] as const) {
      const h = recoveryHarness();
      const artifact = await previewRun(h);
      await h.interruptAt(artifact, "content-complete", auditState);
      expect(await h.recovery.inspect()).toMatchObject({ state: "none" });
      expect(await h.recovery.inspect("preview:one")).toMatchObject({
        state: auditState === "content-complete" ? "content-complete" : "uncertain",
      });
      expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject(APPLIED);
      await expectApplied(h);
    }
  });

  it("continues a student account deletion without touching later backups", async () => {
    const h = recoveryHarness();
    const artifact = await h.service.preview(h.request([h.observe("account", "student:one")]));
    expect(artifact.blockers).toEqual([]);
    await h.interruptAt(artifact, "content-started");
    h.writeBackup("backup-later");
    expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject(APPLIED);
    expect(rowCount(h.database, "marea_users", "id = 'student:one'")).toBe(0);
    expect(rowCount(h.database, "marea_governance_accounts")).toBe(0);
    expect(rowCount(h.database, "marea_runs", "student_id = 'student:one'")).toBe(0);
    expect(rowCount(h.database, "marea_users")).toBe(2);
    expect(existsSync(join(h.backupRoot, "backup-later"))).toBe(true);
    expect(
      h.dependencies
        .auditFor(h.database)
        .dispositions.list("preview:one")
        .map((entry) => [entry.disposition, entry.updatedAt]),
    ).toEqual(artifact.targets.map(() => ["deleted", RECOVERED_AT]));
  });

  it("keeps the operation uncertain when the continuation is interrupted again", async () => {
    const h = recoveryHarness();
    h.writeBackup("backup-a");
    const [backup] = h.backups.list();
    if (backup?.state !== "verified") throw new Error("The fixture backup must verify.");
    const artifact = await h.service.preview(
      h.request([h.observe("run", "run:closed"), backup.target]),
    );
    await h.interruptAt(artifact, "content-started");
    const failing = createDeletionRecoveryService({
      ...h.recoveryDependencies,
      backups: {
        list: () => h.backups.list(),
        dispose: () => {
          throw new Error("disk failure");
        },
      },
    });
    expect(await failing.continueExact(h.continueInput(artifact))).toMatchObject({
      state: "uncertain",
      operationId: "preview:one",
      checkpoint: { state: "uncertain", contentState: "in-progress" },
      reasonCode: "continuation-interrupted",
    });
    expect(h.audit().read("preview:one")).toMatchObject({
      state: "uncertain",
      errorCode: "continuation-interrupted",
    });
    expect(rowCount(h.database, "marea_runs", "id = 'run:closed'")).toBe(0);
    expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject(APPLIED);
    expect(existsSync(join(h.backupRoot, "backup-a"))).toBe(false);
    await expectApplied(h);
  });

  it("refuses to continue while an unverifiable backup could hold a partly disposed bundle", async () => {
    const h = recoveryHarness();
    const artifact = await previewRun(h);
    await h.interruptAt(artifact, "content-started");
    h.writeBackup("not a bundle");
    const result = await h.recovery.continueExact(h.continueInput(artifact));
    expect(result).toMatchObject({
      state: "blocked",
      operationId: "preview:one",
      checkpoint: { state: "committed", contentState: "in-progress" },
      reasonCode: "backup-unverifiable",
    });
    expect(h.audit().read("preview:one")).toMatchObject({ state: "content-started" });
    expect(rowCount(h.database, "marea_runs", "id = 'run:closed'")).toBe(1);
  });
});
