import type { AuditOperationState } from "@marea/sqlite-storage";

import type { PreviewArtifact } from "../schemas.js";
import { deleteRetentionContent } from "../retention/retention-content.js";
import { readRetentionGraph } from "../retention/retention-graph.js";
import { NOW, retentionHarness } from "../retention/retention.fixture.js";
import {
  createDeletionRecoveryService,
  type DeletionRecoveryDependencies,
} from "./deletion-recovery.js";

export const RECOVERED_AT = "2026-09-14T10:01:00.000Z";
const DRAIN = "2026-09-14T10:05:00.000Z";

export type RecoveryHarness = ReturnType<typeof recoveryHarness>;

/** A retention installation plus recovery over the same databases. */
export function recoveryHarness(overrides: Partial<DeletionRecoveryDependencies> = {}) {
  const h = retentionHarness();
  const dependencies: DeletionRecoveryDependencies = {
    coordinator: { exclusive: (operation) => operation(h.database) },
    index: h.index,
    backups: h.backups,
    // Recovery runs later than the interrupted confirmation, so replayed audit rows would differ.
    clock: { now: () => RECOVERED_AT },
    auditFor: h.dependencies.auditFor,
    ...overrides,
  };
  const audit = () => h.dependencies.auditFor(h.database).audit;
  return {
    ...h,
    recoveryDependencies: dependencies,
    recovery: createDeletionRecoveryService(dependencies),
    audit,
    continueInput: (artifact: PreviewArtifact) => ({
      action: "continue-exact" as const,
      operationId: artifact.previewId,
      authorityLineage: artifact.authorityLineage,
      expectedIndexGeneration: artifact.expectedIndexGeneration,
      artifactDigest: artifact.artifactDigest,
      drainUntil: DRAIN,
    }),
    failInput: (artifact: PreviewArtifact) => ({
      action: "mark-failed" as const,
      operationId: artifact.previewId,
      authorityLineage: artifact.authorityLineage,
      expectedIndexGeneration: artifact.expectedIndexGeneration,
    }),
    /**
     * Replays a confirmation up to a crash point: `prepared` records only the audit,
     * later stages also persist the matching index checkpoint and audit state.
     */
    async interruptAt(
      artifact: PreviewArtifact,
      stage:
        | "audit-prepared"
        | "index-prepared"
        | "index-committed"
        | "content-started"
        | "content-complete",
      auditState?: AuditOperationState,
    ) {
      audit().recordPrepared(artifact, NOW);
      if (stage === "audit-prepared") return;
      const prepared = await h.index.prepare({
        operationId: artifact.previewId,
        authorityLineage: artifact.authorityLineage,
        expectedIndexGeneration: artifact.expectedIndexGeneration,
        targets: artifact.targets,
        artifactDigest: artifact.artifactDigest,
      });
      if (stage === "index-prepared") return;
      let checkpoint = await h.index.commit(prepared);
      if (stage === "index-committed") return;
      const advance = (expectedState: AuditOperationState, nextState: AuditOperationState) => {
        audit().advance({ operationId: artifact.previewId, expectedState, nextState, now: NOW });
      };
      advance("prepared", "index-committed");
      checkpoint = await h.index.startContent(checkpoint);
      advance("index-committed", "content-started");
      if (stage === "content-started") return;
      const graph = readRetentionGraph(h.database, h.backups.list(), artifact.targets, NOW);
      deleteRetentionContent(h.database, graph.plan, graph.counts.rows);
      await h.index.completeContent(checkpoint);
      if (auditState === "content-complete") advance("content-started", "content-complete");
    },
  };
}
