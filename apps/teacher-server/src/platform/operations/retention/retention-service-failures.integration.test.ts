import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("./retention-bun-sqlite.fixture.js"));

import { Sha256DigestSchema } from "@marea/protocol";

import type { OperationsBoundaryError } from "../canonical-encoder.js";
import { RetentionPreviewRequestSchema } from "../schemas.js";
import { createRetentionService } from "./retention-service.js";
import { EXPIRES, LATER, NOW, retentionHarness, rowCount } from "./retention.fixture.js";

const OTHER = {
  authorityLineage: "lineage:other",
  installationId: "root:other",
  sourceDatabaseLineage: `sha256:${"e".repeat(64)}`,
} as const;

function boundary(code: OperationsBoundaryError["code"], message: string): unknown {
  return expect.objectContaining({ name: "OperationsBoundaryError", code, message }) as unknown;
}

const INSTALLATION = "The request does not name this installation authority.";
const INDEX_CHANGED = "The deletion index changed since the preview.";

describe("scoped permanent deletion failures", () => {
  it("previews only for this installation, a current index and the fixed lifetime", async () => {
    const h = retentionHarness();
    const request = h.request([h.observe("run", "run:closed")]);
    for (const [field, value] of Object.entries(OTHER))
      await expect(h.service.preview({ ...request, [field]: value })).rejects.toEqual(
        boundary("stale-preview", INSTALLATION),
      );
    await expect(
      h.service.preview({ ...request, expiresAt: "2026-09-14T10:05:00.000Z" }),
    ).rejects.toEqual(boundary("invalid-input", "The preview lifetime is invalid."));
    await expect(h.service.preview({ ...request, expectedIndexGeneration: 1 })).rejects.toEqual(
      boundary("stale-preview", INDEX_CHANGED),
    );
    const corrupt = createRetentionService({
      ...h.dependencies,
      index: {
        ...h.index,
        inspect: async () => ({ ...(await h.index.inspect()), state: "corrupt" }),
      },
    });
    await expect(corrupt.preview(request)).rejects.toEqual(
      boundary("stale-preview", INDEX_CHANGED),
    );
    await h.index.prepare({
      operationId: "other:pending",
      authorityLineage: h.configuration.authorityLineage,
      expectedIndexGeneration: 0,
      targets: [h.observe("run", "run:other")],
      artifactDigest: Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`),
    });
    await expect(h.service.preview(request)).rejects.toEqual(
      boundary("stale-preview", INDEX_CHANGED),
    );
  });

  it("blocks every data deletion when the backup root cannot be inventoried", async () => {
    const h = retentionHarness();
    const service = createRetentionService({
      ...h.dependencies,
      backups: {
        list: () => {
          throw new Error("unreadable");
        },
        dispose: (name) => {
          h.backups.dispose(name);
        },
      },
    });
    const artifact = await service.preview(h.request([h.observe("run", "run:closed")]));
    expect(artifact.blockers).toEqual([
      { code: "unverifiable", target: null, detailCode: "backup-root" },
    ]);
    await expect(service.confirm({ artifact, now: NOW, drainUntil: NOW })).rejects.toEqual(
      boundary("blocked-reference", "The preview has blockers."),
    );
  });

  it("rejects artifacts from another installation, expired, blocked or without a valid drain", async () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    const foreign = createRetentionService({
      ...h.dependencies,
      installation: {
        authorityLineage: OTHER.authorityLineage,
        rootId: OTHER.installationId,
        databaseLineage: OTHER.sourceDatabaseLineage,
      },
    });
    const foreignArtifact = await foreign.preview(
      RetentionPreviewRequestSchema.parse({ ...h.request([run]), ...OTHER }),
    );
    await expect(
      h.service.confirm({ artifact: foreignArtifact, now: NOW, drainUntil: NOW }),
    ).rejects.toEqual(boundary("stale-preview", INSTALLATION));
    const artifact = await h.service.preview(h.request([run]));
    await expect(
      h.service.confirm({ artifact, now: EXPIRES, drainUntil: EXPIRES }),
    ).rejects.toEqual(boundary("stale-preview", "The preview has expired."));
    await expect(
      h.service.confirm({ artifact, now: NOW, drainUntil: "2026-09-14T09:59:59.000Z" }),
    ).rejects.toEqual(boundary("invalid-input", "The drain deadline is invalid."));
    const blocked = await h.service.preview(
      h.request([h.observe("account", "teacher:one")], "preview:blocked"),
    );
    await expect(
      h.service.confirm({ artifact: blocked, now: NOW, drainUntil: LATER }),
    ).rejects.toEqual(boundary("blocked-reference", "The preview has blockers."));
    expect(h.dependencies.auditFor(h.database).audit.read("preview:blocked")).toBeUndefined();
    const drains: unknown[] = [];
    const recorded = createRetentionService({
      ...h.dependencies,
      coordinator: {
        preview: (operation) => h.dependencies.coordinator.preview(operation),
        run: (input, operation) => {
          drains.push(input);
          return h.dependencies.coordinator.run(input, operation);
        },
      },
    });
    const drainUntil = "2026-09-14T10:15:00.000Z";
    await expect(recorded.confirm({ artifact, now: NOW, drainUntil })).resolves.toMatchObject({
      state: "applied",
    });
    expect(drains).toEqual([{ drainUntil }]);
  });

  it("rejects confirmation when the graph or the index changed after preview", async () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    const changed = await h.service.preview(h.request([run]));
    h.database.execute(
      "UPDATE marea_teacher_notices SET acknowledged_at = ?1 WHERE id = 'notice:1'",
      [NOW],
    );
    await expect(
      h.service.confirm({ artifact: changed, now: NOW, drainUntil: NOW }),
    ).rejects.toEqual(boundary("stale-preview", "The reference graph changed since the preview."));
    expect(h.dependencies.auditFor(h.database).audit.read("preview:one")).toBeUndefined();

    const first = await h.service.preview(h.request([h.observe("run", "run:closed")], "preview:a"));
    const second = await h.service.preview(h.request([h.observe("run", "run:other")], "preview:b"));
    expect(await h.service.confirm({ artifact: second, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "applied",
    });
    await expect(h.service.confirm({ artifact: first, now: NOW, drainUntil: NOW })).rejects.toEqual(
      boundary("stale-preview", INDEX_CHANGED),
    );
    expect(rowCount(h.database, "marea_runs", "id = 'run:closed'")).toBe(1);
  });

  it("records a failure before intent when tombstones cannot be prepared or committed", async () => {
    for (const [method, errorCode] of [
      ["prepare", "index-prepare-failed"],
      ["commit", "index-commit-failed"],
    ] as const) {
      const h = retentionHarness();
      const failure = new Error(`${method} failed`);
      const service = createRetentionService({
        ...h.dependencies,
        index: { ...h.index, [method]: () => Promise.reject(failure) },
      });
      const artifact = await service.preview(h.request([h.observe("run", "run:closed")]));
      await expect(service.confirm({ artifact, now: NOW, drainUntil: NOW })).rejects.toBe(failure);
      expect(h.dependencies.auditFor(h.database).audit.read("preview:one")).toMatchObject({
        state: "failed",
        errorCode,
      });
      expect(await h.index.inspect()).toMatchObject({ generation: 0, pendingCheckpoint: null });
      expect(rowCount(h.database, "marea_runs", "id = 'run:closed'")).toBe(1);
      await expect(service.confirm({ artifact, now: NOW, drainUntil: NOW })).rejects.toEqual(
        boundary("stale-preview", "The preview already failed."),
      );
    }
  });

  it("leaves committed tombstones and an uncertain audit when content removal is interrupted", async () => {
    const h = retentionHarness();
    const run = h.observe("run", "run:closed");
    h.writeBackup("backup-a");
    const [backup] = h.backups.list();
    if (backup?.state !== "verified") throw new Error("The fixture backup must verify.");
    const service = createRetentionService({
      ...h.dependencies,
      backups: {
        list: () => h.backups.list(),
        dispose: () => {
          throw new Error("disk failure");
        },
      },
    });
    const artifact = await service.preview(h.request([run, backup.target]));
    expect(artifact.blockers).toEqual([]);
    expect(await service.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "uncertain",
    });
    expect(h.dependencies.auditFor(h.database).audit.read("preview:one")).toMatchObject({
      state: "uncertain",
      errorCode: "content-interrupted",
    });
    expect(await h.index.inspect()).toMatchObject({
      generation: 1,
      pendingCheckpoint: { state: "uncertain", contentState: "in-progress" },
    });
    expect(await h.index.assertCreatable(run)).toEqual({ allowed: false, code: "uncertain" });
    expect(await service.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "uncertain",
    });
  });
});
