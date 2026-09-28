import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../retention/retention-bun-sqlite.fixture.js"));

import { Sha256DigestSchema } from "@marea/protocol";

import { NOW, rowCount } from "../retention/retention.fixture.js";
import { AuthorityLineageSchema } from "../schemas.js";
import { createDeletionRecoveryService, inspectHostRecovery } from "./deletion-recovery.js";
import { recoveryHarness, type RecoveryHarness } from "./deletion-recovery.fixture.js";

async function previewRun(h: RecoveryHarness, previewId = "preview:one", runId = "run:closed") {
  return h.service.preview(h.request([h.observe("run", runId)], previewId));
}

function blocked(reasonCode: string, operationId: string | null = "preview:one") {
  return { state: "blocked", operationId, reasonCode };
}

describe("deletion recovery guards", () => {
  it("decides host readiness from the index alone", async () => {
    const h = recoveryHarness();
    expect(await inspectHostRecovery(h.index)).toEqual({
      state: "none",
      operationId: null,
      checkpoint: null,
      reasonCode: "idle",
    });
    await h.interruptAt(await previewRun(h), "index-prepared");
    expect(await inspectHostRecovery(h.index)).toMatchObject({
      state: "prepared",
      operationId: "preview:one",
      reasonCode: "pending-checkpoint",
    });
  });

  it("marks failures only before durable intent, with or without an index checkpoint", async () => {
    for (const stage of ["audit-prepared", "index-prepared"] as const) {
      const h = recoveryHarness();
      const artifact = await previewRun(h);
      await h.interruptAt(artifact, stage);
      if (stage === "index-prepared")
        expect(await h.recovery.inspect()).toMatchObject({
          state: "prepared",
          operationId: "preview:one",
          checkpoint: { state: "prepared", durableIntent: "none" },
        });
      else expect(await h.recovery.inspect("preview:one")).toMatchObject({ state: "uncertain" });
      expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject(
        blocked("no-durable-intent"),
      );
      expect(h.audit().read("preview:one")).toMatchObject({ state: "prepared" });
      expect(await h.recovery.markFailed(h.failInput(artifact))).toEqual({
        state: "failed",
        operationId: "preview:one",
        checkpoint: null,
        reasonCode: "failed",
      });
      expect(h.audit().read("preview:one")).toMatchObject({
        state: "failed",
        errorCode: "operator-marked-failed",
      });
      expect(await h.index.inspect()).toMatchObject({ generation: 0, pendingCheckpoint: null });
      expect(rowCount(h.database, "marea_runs", "id = 'run:closed'")).toBe(1);
      expect(await h.recovery.markFailed(h.failInput(artifact))).toMatchObject({ state: "failed" });
      expect(await h.recovery.continueExact(h.continueInput(artifact))).toMatchObject({
        state: "failed",
        reasonCode: "failed",
      });
      expect(await h.recovery.inspect("preview:one")).toMatchObject({ state: "failed" });
    }
  });

  it("never marks failed once tombstones may be committed", async () => {
    const h = recoveryHarness();
    const artifact = await previewRun(h);
    await h.interruptAt(artifact, "index-committed");
    expect(await h.recovery.markFailed(h.failInput(artifact))).toMatchObject(
      blocked("durable-intent-possible"),
    );
    const other = recoveryHarness();
    const otherArtifact = await previewRun(other);
    await other.interruptAt(otherArtifact, "content-complete", "content-started");
    expect(await other.recovery.markFailed(other.failInput(otherArtifact))).toMatchObject(
      blocked("durable-intent-possible"),
    );
    expect(other.audit().read("preview:one")).toMatchObject({ state: "content-started" });
  });

  it("rejects operations that do not match the durable audit evidence", async () => {
    const h = recoveryHarness();
    const artifact = await previewRun(h);
    await h.interruptAt(artifact, "index-committed");
    const input = h.continueInput(artifact);
    const continued: Partial<typeof input>[] = [
      { operationId: "preview:unknown" },
      { authorityLineage: AuthorityLineageSchema.parse("lineage:other") },
      { expectedIndexGeneration: 1 },
      { artifactDigest: Sha256DigestSchema.parse(`sha256:${"f".repeat(64)}`) },
    ];
    for (const changed of continued)
      expect(await h.recovery.continueExact({ ...input, ...changed })).toMatchObject({
        state: "blocked",
        checkpoint: null,
        reasonCode: "evidence-mismatch",
      });
    const fail = h.failInput(artifact);
    const failed: Partial<typeof fail>[] = [
      { operationId: "preview:unknown" },
      { authorityLineage: AuthorityLineageSchema.parse("lineage:other") },
      { expectedIndexGeneration: 1 },
    ];
    for (const changed of failed)
      expect(await h.recovery.markFailed({ ...fail, ...changed })).toMatchObject({
        state: "blocked",
        reasonCode: "evidence-mismatch",
      });
    expect(await h.recovery.inspect("preview:unknown")).toMatchObject(
      blocked("other-operation-pending", "preview:unknown"),
    );
    await expect(
      h.recovery.continueExact({ ...input, drainUntil: "2026-09-14T09:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "invalid-input", message: "The drain deadline is invalid." });
  });

  it("does not touch an operation while another one owns the pending checkpoint", async () => {
    const h = recoveryHarness();
    const first = await previewRun(h, "preview:a");
    const second = await previewRun(h, "preview:b", "run:other");
    h.audit().recordPrepared(first, NOW);
    await h.interruptAt(second, "index-prepared");
    expect(await h.recovery.continueExact(h.continueInput(first))).toMatchObject(
      blocked("other-operation-pending", "preview:a"),
    );
    expect(await h.recovery.markFailed(h.failInput(first))).toMatchObject(
      blocked("other-operation-pending", "preview:a"),
    );
    expect(h.audit().read("preview:a")).toMatchObject({ state: "prepared" });
    expect(await h.recovery.markFailed(h.failInput(second))).toMatchObject({ state: "failed" });
    await expect(
      h.service.confirm({ artifact: second, now: NOW, drainUntil: NOW }),
    ).rejects.toThrow("The preview already failed.");
  });

  it("cannot prove a pre-intent failure after the index generation moved on", async () => {
    const h = recoveryHarness();
    const stuck = await previewRun(h, "preview:a");
    const other = await previewRun(h, "preview:b", "run:other");
    h.audit().recordPrepared(stuck, NOW);
    expect(await h.service.confirm({ artifact: other, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "applied",
    });
    expect(await h.recovery.markFailed(h.failInput(stuck))).toMatchObject(
      blocked("no-intent-unproven", "preview:a"),
    );
    expect(await h.recovery.continueExact(h.continueInput(stuck))).toMatchObject(
      blocked("no-durable-intent", "preview:a"),
    );
    expect(h.audit().read("preview:a")).toMatchObject({ state: "prepared" });
  });

  it("reports blocked authority without opening the database", async () => {
    const h = recoveryHarness();
    const artifact = await previewRun(h);
    await h.interruptAt(artifact, "index-committed");
    const opened: string[] = [];
    const recovery = createDeletionRecoveryService({
      ...h.recoveryDependencies,
      coordinator: {
        exclusive: (operation) => {
          opened.push("exclusive");
          return operation(h.database);
        },
      },
      index: {
        ...h.index,
        inspect: async () => ({ ...(await h.index.inspect()), state: "corrupt" }),
      },
    });
    const pending = (await h.index.inspect()).pendingCheckpoint;
    expect(await recovery.inspect()).toEqual({
      state: "blocked",
      operationId: null,
      checkpoint: pending,
      reasonCode: "index-corrupt",
    });
    expect(opened).toEqual([]);
    expect(await recovery.continueExact(h.continueInput(artifact))).toMatchObject(
      blocked("index-corrupt"),
    );
    expect(await h.recovery.inspect("preview:none")).toMatchObject(
      blocked("other-operation-pending", "preview:none"),
    );
    expect(h.audit().read("preview:one")).toMatchObject({ state: "prepared" });
  });

  it("reports audit records when no checkpoint is pending", async () => {
    const h = recoveryHarness();
    expect(await h.recovery.inspect("preview:none")).toEqual({
      state: "none",
      operationId: "preview:none",
      checkpoint: null,
      reasonCode: "audit-record",
    });
  });
});
