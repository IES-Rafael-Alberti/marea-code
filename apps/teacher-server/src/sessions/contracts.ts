import type {
  CanonicalRunEvent,
  CloseRunRequest,
  OpenRunRequest,
  StudentRunSnapshot,
  RunStartupState,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { TeachingSnapshotContent } from "../teaching/configuration/configuration-schema.js";
import type { PrivateProviderRoute } from "../model-gateway/route-policy.js";
export type { PrivateProviderRoute } from "../model-gateway/route-policy.js";

export interface AuthorizedRunLease {
  readonly providerRoute: PrivateProviderRoute;
  readonly runId: string;
  readonly studentId: string;
}

export interface AuthorizeRunLeaseInput {
  readonly leaseTokenHash: string;
  readonly now: string;
}

export interface RunSnapshotCapture {
  readonly providerRoute: PrivateProviderRoute;
  readonly snapshot: StudentRunSnapshot;
  readonly teaching?: TeachingSnapshotContent;
}

export interface RunSnapshotSource {
  capture(snapshotId: string, identity: AuthenticatedIdentity): RunSnapshotCapture;
}

export interface OpenStoredRunInput {
  readonly activatedEventId: string;
  readonly clientSessionId: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly intent: OpenRunRequest["intent"];
  readonly issuedAt: string;
  readonly leaseId: string;
  readonly leaseTokenHash: string;
  readonly openedAt: string;
  readonly projectDisplayName: string;
  readonly proposedRunId: string;
  readonly requestId: string;
  readonly resumeRunId?: string;
  /** Called once, inside the transaction, only when creating a genuinely new run. */
  readonly captureSnapshot: () => RunSnapshotCapture;
  readonly student: AuthenticatedIdentity;
}

export interface OpenStoredRunResult {
  readonly startupState?: RunStartupState;
  readonly highestDurableSequence: number;
  readonly runId: string;
  readonly snapshot: StudentRunSnapshot;
}

export interface AppendEventsInput {
  readonly events: readonly CanonicalRunEvent[];
  readonly leaseTokenHash: string;
  readonly now: string;
}

export interface CloseStoredRunInput {
  readonly closedAt: string;
  readonly closingEventId: string;
  readonly leaseTokenHash: string;
  readonly reason: CloseRunRequest["reason"];
}

export interface CloseAuthenticatedRunInput {
  readonly closedAt: string;
  readonly closingEventId: string;
  readonly reason: CloseRunRequest["reason"];
  readonly runId: string;
  readonly studentId: string;
}

export interface RenewStoredLeaseInput {
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly leaseId: string;
  readonly leaseTokenHash: string;
  readonly runId: string;
  readonly studentId: string;
}

export interface RenewStoredLeaseResult {
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly runId: string;
}

export interface CloseStoredRunResult {
  readonly alreadyClosed: boolean;
  readonly runId: string;
}

export interface RunSessionRepository {
  appendEvents(input: AppendEventsInput): number;
  authorizeLease(input: AuthorizeRunLeaseInput): AuthorizedRunLease;
  closeRunAuthenticated(input: CloseAuthenticatedRunInput): CloseStoredRunResult;
  closeRun(input: CloseStoredRunInput): CloseStoredRunResult;
  openRun(input: OpenStoredRunInput): OpenStoredRunResult;
  renewLease(input: RenewStoredLeaseInput): RenewStoredLeaseResult;
}
