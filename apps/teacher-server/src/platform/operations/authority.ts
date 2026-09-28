import { createHash } from "node:crypto";
import type { Sha256Digest } from "@marea/protocol";

import {
  AuthorityCheckpointSchema,
  BootstrapContinuationSchema,
  BootstrapMarkerSchema,
  HandoffRetirementSchema,
  MarkerOnlyRetirementSchema,
  TransferHandoffSchema,
  type AuthorityCheckpoint,
  type TransferHandoff,
  type TransferState,
} from "./schemas.js";
import { canonicalJsonBytes, protocolDigest } from "./canonical-encoder.js";

export function authorityCheckpointDigest(checkpoint: AuthorityCheckpoint): Sha256Digest {
  const parsed = AuthorityCheckpointSchema.parse(checkpoint);
  return protocolDigest(canonicalJsonBytes(parsed));
}

export function copiedFileDigest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256Digest;
}

export type TransferEvent =
  | { readonly type: "copy-complete"; readonly copiedBytes?: Uint8Array }
  | {
      readonly type: "source-retired";
      readonly evidence: NonNullable<TransferHandoff["sourceRetirementEvidence"]>;
    }
  | { readonly type: "destination-activate"; readonly destinationCheckpoint: AuthorityCheckpoint }
  | { readonly type: "abort" };

export interface TransferTransition {
  readonly accepted: boolean;
  readonly state: TransferState;
  readonly destinationState: TransferHandoff["destinationState"];
  readonly reason: "accepted" | "invalid-state" | "invalid-evidence";
}

export function transitionTransfer(
  handoff: TransferHandoff,
  event: TransferEvent,
): TransferTransition {
  const current = TransferHandoffSchema.parse(handoff);
  if (event.type === "copy-complete" && current.state === "prepared") {
    if (!validateTransferReadiness(current, event.copiedBytes))
      return {
        accepted: false,
        state: current.state,
        destinationState: current.destinationState,
        reason: "invalid-evidence",
      };
    return { accepted: true, state: "copied", destinationState: "inactive", reason: "accepted" };
  }
  if (event.type === "source-retired" && current.state === "copied") {
    if (current.sourceRoot === current.destinationRoot || current.destinationState !== "inactive")
      return {
        accepted: false,
        state: current.state,
        destinationState: current.destinationState,
        reason: "invalid-state",
      };
    const candidate = {
      ...current,
      state: "source-retired" as const,
      sourceRetirementEvidence: event.evidence,
    };
    if (!hasMatchingAuthorityCheckpoint(candidate) || !hasMatchingRetirementEvidence(candidate))
      return {
        accepted: false,
        state: current.state,
        destinationState: current.destinationState,
        reason: "invalid-evidence",
      };
    return {
      accepted: true,
      state: "source-retired",
      destinationState: "inactive",
      reason: "accepted",
    };
  }
  if (event.type === "destination-activate" && current.state === "source-retired") {
    const candidate = {
      ...current,
      state: "destination-active" as const,
      destinationState: "active" as const,
      destinationCheckpoint: event.destinationCheckpoint,
    };
    if (!validateTransferPublication(candidate))
      return {
        accepted: false,
        state: current.state,
        destinationState: current.destinationState,
        reason: "invalid-evidence",
      };
    return {
      accepted: true,
      state: "destination-active",
      destinationState: "active",
      reason: "accepted",
    };
  }
  if (event.type === "abort") {
    if (current.state === "prepared" || current.state === "copied") {
      return { accepted: true, state: "aborted", destinationState: "blocked", reason: "accepted" };
    }
    return {
      accepted: false,
      state: current.state,
      destinationState: current.destinationState,
      reason: "invalid-state",
    };
  }
  return {
    accepted: false,
    state: current.state,
    destinationState: current.destinationState,
    reason: "invalid-state",
  };
}

export function validateTransferPublication(
  handoff: TransferHandoff,
  copiedBytes?: Uint8Array,
): boolean {
  const parsed = TransferHandoffSchema.parse(handoff);
  if (parsed.destinationState !== "active") return false;
  if (parsed.state !== "destination-active") return false;
  if (copiedBytes !== undefined && copiedFileDigest(copiedBytes) !== parsed.copiedFileDigest)
    return false;
  // The advertised source checkpoint digest is evidence, not an assertion. It
  // must be recomputed from the actual source checkpoint before either the
  // retirement or destination evidence can authorize publication.
  if (parsed.sourceRoot === parsed.destinationRoot || !hasMatchingAuthorityCheckpoint(parsed))
    return false;
  const retirementMatches = hasMatchingRetirementEvidence(parsed);
  const destinationMatches = hasMatchingDestinationCheckpoint(parsed);
  return retirementMatches && destinationMatches;
}

export function validateTransferReadiness(
  handoff: TransferHandoff,
  copiedBytes?: Uint8Array,
): boolean {
  const parsed = TransferHandoffSchema.parse(handoff);
  if (parsed.sourceRoot === parsed.destinationRoot) return false;
  if (parsed.destinationState !== "inactive") return false;
  if (parsed.state !== "prepared" && parsed.state !== "copied") return false;
  if (parsed.sourceRetirementEvidence !== undefined) return false;
  if (copiedBytes !== undefined && copiedFileDigest(copiedBytes) !== parsed.copiedFileDigest)
    return false;
  return hasMatchingAuthorityCheckpoint(parsed);
}

export function validateBootstrapContinuation(input: unknown, marker: unknown): boolean {
  const action = BootstrapContinuationSchema.parse(input);
  const current = BootstrapMarkerSchema.parse(marker);
  return (
    protocolDigest(canonicalJsonBytes(action)) ===
    protocolDigest(
      canonicalJsonBytes({
        action: "continue-bootstrap",
        marker: current,
        destinationRoot: current.rootId,
        releaseId: current.releaseId,
        missing: action.missing,
        expectedAuthorityLineage: current.authorityLineage,
      }),
    )
  );
}

export function canRetireRoot(input: unknown): boolean {
  const markerOnly = MarkerOnlyRetirementSchema.safeParse(input);
  if (markerOnly.success) {
    const value = markerOnly.data;
    return (
      value.marker.rootId === value.currentRootId &&
      value.marker.authorityLineage === value.currentAuthorityLineage &&
      value.marker.releaseId === value.currentReleaseId
    );
  }
  const handoffRetirement = HandoffRetirementSchema.safeParse(input);
  if (!handoffRetirement.success) return false;
  const value = handoffRetirement.data;
  const handoff = value.handoff;
  if (handoff.state !== "source-retired" && handoff.state !== "destination-active") return false;
  if (handoff.sourceRoot === handoff.destinationRoot) return false;
  if (
    (handoff.state === "source-retired" && handoff.destinationState !== "inactive") ||
    (handoff.state === "destination-active" && handoff.destinationState !== "active")
  )
    return false;
  if (
    value.marker.rootId !== value.currentRootId ||
    value.marker.authorityLineage !== value.currentAuthorityLineage ||
    value.marker.releaseId !== value.currentReleaseId ||
    handoff.destinationRoot !== value.currentRootId ||
    handoff.authorityLineage !== value.currentAuthorityLineage
  )
    return false;
  if (!hasMatchingAuthorityCheckpoint(handoff)) return false;
  return hasMatchingRetirementEvidence(handoff);
}

function hasMatchingRetirementEvidence(
  handoff: TransferHandoff & { readonly authorityCheckpoint: AuthorityCheckpoint },
): boolean {
  const evidence = handoff.sourceRetirementEvidence;
  const source = handoff.authorityCheckpoint;
  if (evidence === undefined) return false;
  return (
    protocolDigest(canonicalJsonBytes(evidence)) ===
    protocolDigest(
      canonicalJsonBytes({
        ...evidence,
        handoffId: handoff.handoffId,
        rootId: handoff.sourceRoot,
        authorityLineage: handoff.authorityLineage,
        indexGeneration: handoff.expectedIndexGeneration,
        databaseLineage: source.databaseLineage,
        bundleManifestDigest: source.bundleManifestDigest,
        checkpointDigest: handoff.authorityCheckpointDigest,
        copiedFileDigest: handoff.copiedFileDigest,
      }),
    )
  );
}

function hasMatchingAuthorityCheckpoint(
  handoff: TransferHandoff,
): handoff is TransferHandoff & { readonly authorityCheckpoint: AuthorityCheckpoint } {
  const checkpoint = handoff.authorityCheckpoint;
  if (checkpoint === undefined) return false;
  return (
    checkpoint.authorityLineage === handoff.authorityLineage &&
    checkpoint.rootId === handoff.sourceRoot &&
    checkpoint.indexGeneration === handoff.expectedIndexGeneration &&
    handoff.authorityCheckpointDigest === authorityCheckpointDigest(checkpoint)
  );
}

function hasMatchingDestinationCheckpoint(
  handoff: TransferHandoff & { readonly authorityCheckpoint: AuthorityCheckpoint },
): boolean {
  const checkpoint = handoff.destinationCheckpoint;
  if (checkpoint === undefined) return false;
  // validateTransferPublication establishes the source checkpoint invariant
  // before reaching this helper.
  const source = handoff.authorityCheckpoint;
  return (
    authorityCheckpointDigest({
      authorityLineage: handoff.authorityLineage,
      rootId: handoff.destinationRoot,
      indexGeneration: handoff.expectedIndexGeneration,
      databaseLineage: source.databaseLineage,
      bundleManifestDigest: source.bundleManifestDigest,
    }) === authorityCheckpointDigest(checkpoint)
  );
}
