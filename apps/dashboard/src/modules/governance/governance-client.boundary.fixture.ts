import { vi } from "vitest";

import {
  GovernanceAccessResponseSchema,
  GovernanceAccountCreatedResponseSchema,
  GovernanceAccountRenamedResponseSchema,
  GovernanceAccountStateChangedResponseSchema,
  GovernanceClassCreatedResponseSchema,
  GovernanceClassExportedResponseSchema,
  GovernanceClassImportConfirmedResponseSchema,
  GovernanceClassImportCancelledResponseSchema,
  GovernanceClassImportPreviewedResponseSchema,
  GovernanceClassRenamedResponseSchema,
  GovernanceClassRevisionResponseSchema,
  GovernanceClassesResponseSchema,
  GovernanceAccountsResponseSchema,
  GovernanceCentersResponseSchema,
  GovernanceMembershipChangedResponseSchema,
  GovernanceMembershipsResponseSchema,
  GovernanceSessionsRevokedResponseSchema,
  RevisionIdSchema,
  GovernanceRequestSchema,
} from "@marea/protocol";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { createGovernanceClient } from "./governance-client.boundary.js";

export const signal = new AbortController().signal;
export const id = (value: string) => RevisionIdSchema.parse(value);
export const envelope = { protocolVersion: "0.1" as const, requestId: "request:one" };
export const centerId = id("center:1");
export const classId = id("class:1");
export const userId = id("user:1");
export const version = id("version:1");
export const previewId = id("preview:1");
export const exchange = {
  format: "marea-class-exchange:1" as const,
  source: { displayName: "Source" },
  agentMode: "tutoring" as const,
  classInstructions: { tutoring: "Teach", free: "Explore" },
  selection: { didactic: [], evaluation: [] },
};

export function responseFor(kind: string) {
  const page = { items: [], nextAfterId: null };
  switch (kind) {
    case "governance-access-query":
      return GovernanceAccessResponseSchema.parse({
        ...envelope,
        kind: "governance-access-response",
        access: { administrator: true },
      });
    case "governance-centers-query":
      return GovernanceCentersResponseSchema.parse({
        ...envelope,
        kind: "governance-centers-response",
        ...page,
      });
    case "governance-classes-query":
      return GovernanceClassesResponseSchema.parse({
        ...envelope,
        kind: "governance-classes-response",
        ...page,
      });
    case "governance-accounts-query":
      return GovernanceAccountsResponseSchema.parse({
        ...envelope,
        kind: "governance-accounts-response",
        ...page,
      });
    case "governance-memberships-query":
      return GovernanceMembershipsResponseSchema.parse({
        ...envelope,
        kind: "governance-memberships-response",
        ...page,
      });
    case "governance-class-revision-query":
      return GovernanceClassRevisionResponseSchema.parse({
        ...envelope,
        kind: "governance-class-revision-response",
        centerId,
        classId,
        teachingVersion: null,
      });
    case "governance-class-create":
      return GovernanceClassCreatedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-created",
        classroom: { classId, centerId, displayName: "New class", version, operatorReady: true },
      });
    case "governance-class-rename":
      return GovernanceClassRenamedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-renamed",
        classroom: { classId, centerId, displayName: "Renamed", version, operatorReady: true },
      });
    case "governance-account-create":
      return GovernanceAccountCreatedResponseSchema.parse({
        ...envelope,
        kind: "governance-account-created",
        account: {
          userId,
          centerId,
          displayName: "Teacher",
          role: "teacher",
          state: "pending",
          version,
          canManageAccount: true,
        },
      });
    case "governance-account-rename":
      return GovernanceAccountRenamedResponseSchema.parse({
        ...envelope,
        kind: "governance-account-renamed",
        account: {
          userId,
          centerId,
          displayName: "Renamed",
          role: "teacher",
          state: "active",
          version,
          canManageAccount: true,
        },
      });
    case "governance-account-state-change":
      return GovernanceAccountStateChangedResponseSchema.parse({
        ...envelope,
        kind: "governance-account-state-changed",
        account: {
          userId,
          centerId,
          displayName: "Teacher",
          role: "teacher",
          state: "disabled",
          version,
          canManageAccount: true,
        },
      });
    case "governance-membership-change":
      return GovernanceMembershipChangedResponseSchema.parse({
        ...envelope,
        kind: "governance-membership-changed",
        membership: { classId, centerId, userId, role: "teacher", state: "active", version },
      });
    case "governance-sessions-revoke":
      return GovernanceSessionsRevokedResponseSchema.parse({
        ...envelope,
        kind: "governance-sessions-revoked",
        revocation: { userId, version, revokedAt: "2026-09-12T10:00:00Z" },
      });
    case "governance-class-export":
      return GovernanceClassExportedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-exported",
        package: exchange,
      });
    case "governance-class-import-preview":
      return GovernanceClassImportPreviewedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-import-previewed",
        preview: {
          previewId,
          centerId,
          classId,
          expectedTeachingVersion: null,
          expiresAt: "2026-09-12T10:00:00Z",
          packageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          settings: {
            agentMode: "tutoring",
            classInstructions: exchange.classInstructions,
            selection: exchange.selection,
            automaticEvaluation: false,
          },
          preservesDestinationEvaluationPolicy: true,
        },
      });
    case "governance-class-import-confirm":
      return GovernanceClassImportConfirmedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-import-confirmed",
        classId,
        teachingVersion: version,
      });
    case "governance-class-import-cancel":
      return GovernanceClassImportCancelledResponseSchema.parse({
        ...envelope,
        kind: "governance-class-import-cancelled",
        previewId,
      });
    default:
      throw new Error(`Unhandled request kind ${kind}`);
  }
}

export function setup() {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetchRequest = vi.fn<DashboardFetch>((path, init) => {
    calls.push({ path, init });
    const body = readRequest(init);
    return Promise.resolve(new Response(JSON.stringify(responseFor(body.kind)), { status: 200 }));
  });
  return { calls, fetchRequest, client: createGovernanceClient(fetchRequest, () => "request:one") };
}

export function readRequest(init: RequestInit | undefined) {
  if (typeof init?.body !== "string") throw new Error("Expected a serialized governance request");
  return GovernanceRequestSchema.parse(JSON.parse(init.body));
}

export function mockFetch(reply: (...args: Parameters<DashboardFetch>) => Response) {
  return vi.fn<DashboardFetch>((...args) => {
    try {
      return Promise.resolve(reply(...args));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Fetch fixture failed"));
    }
  });
}

export function classRow(value: string, overrides: object = {}) {
  return {
    classId: id(value),
    centerId,
    displayName: value,
    version,
    operatorReady: true,
    ...overrides,
  };
}

export function accountRow(value: string, overrides: object = {}) {
  return {
    userId: id(value),
    centerId,
    displayName: value,
    role: "teacher",
    state: "active",
    version,
    canManageAccount: true,
    ...overrides,
  };
}

export function classPageFetch(ids: string[], nextAfterId: string | null) {
  return mockFetch(
    (_path, init) =>
      new Response(
        JSON.stringify({
          ...envelope,
          requestId: readRequest(init).requestId,
          kind: "governance-classes-response",
          items: ids.map((value) => classRow(value)),
          nextAfterId,
        }),
      ),
  );
}
