import { createHash } from "node:crypto";

import {
  AppendRunEventsResponseSchema,
  CloseRunRequestSchema,
  CloseRunResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  OpenRunResponseSchema,
  RenewRunLeaseRequestSchema,
  RenewRunLeaseResponseSchema,
  type AppendRunEventsRequest,
  type AppendRunEventsResponse,
  type CloseRunRequest,
  type CloseRunResponse,
  type OpenRunRequest,
  type OpenRunResponse,
  type RenewRunLeaseRequest,
  type RenewRunLeaseResponse,
} from "@marea/protocol";

import type {
  AuthenticatedIdentity,
  Clock,
  IdGenerator,
  SecretDigest,
  SecretIssuer,
} from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { AuthorizedRunLease, RunSessionRepository, RunSnapshotSource } from "./contracts.js";

const LEASE_DURATION_MS = 10 * 60 * 1_000;

export interface RunSessionServiceDependencies {
  readonly clock: Clock;
  readonly digest: SecretDigest;
  readonly ids: IdGenerator;
  readonly repository: RunSessionRepository;
  readonly secrets: SecretIssuer;
  readonly snapshots: RunSnapshotSource;
}

/** The class the authenticated student session acts for. */
function requireStudent(identity: AuthenticatedIdentity): string {
  if (identity.role !== "student" || identity.classId === null) {
    throw new TeacherDomainError("run.unavailable");
  }
  return identity.classId;
}

function leaseExpiry(issuedAt: string): string {
  return new Date(Date.parse(issuedAt) + LEASE_DURATION_MS).toISOString();
}

function fingerprint(request: OpenRunRequest): string {
  const canonical = JSON.stringify({
    clientSessionId: request.clientSessionId,
    intent: request.intent,
    project: request.project,
    runId: request.runId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class RunSessionService {
  readonly #dependencies: RunSessionServiceDependencies;

  public constructor(dependencies: RunSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public open(
    identity: AuthenticatedIdentity,
    request: OpenRunRequest,
    socraticSupport = false,
  ): OpenRunResponse {
    requireStudent(identity);
    const issuedAt = this.#dependencies.clock.now();
    const token = this.#dependencies.secrets.issue();
    const snapshotId = this.#dependencies.ids.createId("snapshot");
    const stored = this.#dependencies.repository.openRun({
      activatedEventId: this.#dependencies.ids.createId("event"),
      clientSessionId: request.clientSessionId,
      expiresAt: leaseExpiry(issuedAt),
      fingerprint: fingerprint(request),
      idempotencyKey: request.idempotencyKey,
      intent: request.intent,
      issuedAt,
      leaseId: this.#dependencies.ids.createId("lease"),
      leaseTokenHash: this.#dependencies.digest.digest(token),
      openedAt: issuedAt,
      projectDisplayName: request.project.displayName,
      proposedRunId: this.#dependencies.ids.createId("run"),
      requestId: request.requestId,
      ...(request.runId === undefined ? {} : { resumeRunId: request.runId }),
      captureSnapshot: () => this.#dependencies.snapshots.capture(snapshotId, identity),
      acceptSnapshot: (snapshot) => {
        if (
          !socraticSupport &&
          snapshot.agentMode === "tutoring" &&
          snapshot.socraticMode !== undefined &&
          snapshot.socraticMode !== "off"
        )
          throw new TeacherDomainError("protocol.incompatible");
      },
      student: identity,
    });
    if (request.runId !== undefined && stored.runId !== request.runId) {
      throw new TeacherDomainError("run.unavailable");
    }
    const snapshot = { ...stored.snapshot };
    if (!socraticSupport) Reflect.deleteProperty(snapshot, "socraticMode");
    return OpenRunResponseSchema.parse({
      lease: {
        expiresAt: leaseExpiry(issuedAt),
        issuedAt,
        runId: stored.runId,
        token,
      },
      highestDurableSequence: stored.highestDurableSequence,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      snapshot,
      ...(stored.startupState === undefined ? {} : { startupState: stored.startupState }),
    });
  }

  public append(leaseToken: string, request: AppendRunEventsRequest): AppendRunEventsResponse {
    const highestDurableSequence = this.#dependencies.repository.appendEvents({
      events: request.events,
      leaseTokenHash: this.#dependencies.digest.digest(leaseToken),
      now: this.#dependencies.clock.now(),
    });
    return AppendRunEventsResponseSchema.parse({
      highestDurableSequence,
      kind: "run-events-acknowledged",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
    });
  }

  public authorizeLease(leaseToken: string): AuthorizedRunLease {
    return this.#dependencies.repository.authorizeLease({
      leaseTokenHash: this.#dependencies.digest.digest(leaseToken),
      now: this.#dependencies.clock.now(),
    });
  }

  public renew(
    identity: AuthenticatedIdentity,
    request: RenewRunLeaseRequest,
  ): RenewRunLeaseResponse {
    RenewRunLeaseRequestSchema.parse(request);
    const classId = requireStudent(identity);
    const issuedAt = this.#dependencies.clock.now();
    const token = this.#dependencies.secrets.issue();
    const stored = this.#dependencies.repository.renewLease({
      classId,
      expiresAt: leaseExpiry(issuedAt),
      issuedAt,
      leaseId: this.#dependencies.ids.createId("lease"),
      leaseTokenHash: this.#dependencies.digest.digest(token),
      runId: request.runId,
      studentId: identity.userId,
    });
    if (stored.runId !== request.runId) throw new TeacherDomainError("run.unavailable");
    return RenewRunLeaseResponseSchema.parse({
      kind: "run-lease-renewed",
      lease: {
        expiresAt: stored.expiresAt,
        issuedAt: stored.issuedAt,
        runId: stored.runId,
        token,
      },
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
    });
  }

  public closeAuthenticated(
    identity: AuthenticatedIdentity,
    request: CloseRunRequest,
  ): CloseRunResponse {
    CloseRunRequestSchema.parse(request);
    const classId = requireStudent(identity);
    if (request.runId === undefined) throw new TeacherDomainError("run.unavailable");
    const stored = this.#dependencies.repository.closeRunAuthenticated({
      classId,
      closedAt: this.#dependencies.clock.now(),
      closingEventId: this.#dependencies.ids.createId("event"),
      reason: request.reason,
      runId: request.runId,
      studentId: identity.userId,
    });
    if (stored.runId !== request.runId) throw new TeacherDomainError("run.unavailable");
    return CloseRunResponseSchema.parse({
      alreadyClosed: stored.alreadyClosed,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      runId: stored.runId,
      state: "closed",
    });
  }

  public close(
    leaseToken: string,
    requestId: string,
    reason: CloseRunRequest["reason"],
  ): CloseRunResponse {
    const stored = this.#dependencies.repository.closeRun({
      closedAt: this.#dependencies.clock.now(),
      closingEventId: this.#dependencies.ids.createId("event"),
      leaseTokenHash: this.#dependencies.digest.digest(leaseToken),
      reason,
    });
    return CloseRunResponseSchema.parse({
      alreadyClosed: stored.alreadyClosed,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId,
      runId: stored.runId,
      state: "closed",
    });
  }
}
