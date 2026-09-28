import {
  GovernanceAccessResponseSchema,
  GovernanceAccountCreatedResponseSchema,
  GovernanceAccountRenamedResponseSchema,
  GovernanceAccountStateChangedResponseSchema,
  GovernanceClassCreatedResponseSchema,
  GovernanceClassExportedResponseSchema,
  GovernanceClassImportConfirmedResponseSchema,
  GovernanceClassImportPreviewedResponseSchema,
  GovernanceClassRevisionResponseSchema,
  GovernanceClassRenamedResponseSchema,
  GovernanceClassesResponseSchema,
  GovernanceAccountsResponseSchema,
  GovernanceCentersResponseSchema,
  GovernanceMembershipChangedResponseSchema,
  GovernanceMembershipsResponseSchema,
  GovernanceSessionsRevokedResponseSchema,
  GovernanceClassImportCancelledResponseSchema,
  RevisionIdSchema,
  type ClassExchange,
} from "@marea/protocol";
import { vi } from "vitest";

import type { GovernanceClient } from "./governance-contracts.js";

export const CENTER_A = RevisionIdSchema.parse("center:a");
export const CENTER_B = RevisionIdSchema.parse("center:b");
export const CLASS_A = RevisionIdSchema.parse("class:a");
export const CLASS_B = RevisionIdSchema.parse("class:b");
export const USER_A = RevisionIdSchema.parse("user:a");
export const USER_B = RevisionIdSchema.parse("user:b");
export const VERSION_A = RevisionIdSchema.parse("version:a");
export const VERSION_B = RevisionIdSchema.parse("version:b");
export const PREVIEW_A = RevisionIdSchema.parse("preview:a");

export const exchange: ClassExchange = {
  format: "marea-class-exchange:1",
  source: { displayName: "Source class" },
  agentMode: "tutoring",
  classInstructions: { tutoring: "Teach", free: "Explore" },
  selection: { didactic: [], evaluation: [] },
};

const envelope = { protocolVersion: "0.1" as const, requestId: "request:controller" };

function center(centerId = CENTER_A) {
  return { centerId, displayName: `Center ${centerId.slice(-1)}`, version: VERSION_A };
}

export function classroom(classId = CLASS_A, centerId = CENTER_A, displayName = "Physics") {
  return { classId, centerId, displayName, version: VERSION_A, operatorReady: true };
}

export function account(userId = USER_A, centerId = CENTER_A, displayName = "Teacher") {
  return {
    userId,
    centerId,
    displayName,
    role: "teacher" as const,
    state: "active" as const,
    version: VERSION_A,
    canManageAccount: true,
  };
}

function membership(userId = USER_A, classId = CLASS_A, centerId = CENTER_A) {
  return {
    userId,
    classId,
    centerId,
    role: "teacher" as const,
    state: "active" as const,
    version: VERSION_A,
  };
}

export function preview(expiresAt = "2099-01-01T00:00:00.000Z") {
  return {
    previewId: PREVIEW_A,
    centerId: CENTER_A,
    classId: CLASS_A,
    expectedTeachingVersion: VERSION_A,
    expiresAt,
    packageDigest: `sha256:${"a".repeat(64)}`,
    settings: {
      agentMode: "tutoring" as const,
      classInstructions: exchange.classInstructions,
      selection: exchange.selection,
      automaticEvaluation: false,
    },
    preservesDestinationEvaluationPolicy: true as const,
  };
}

export function controllerClient() {
  const client = {
    access: vi.fn().mockResolvedValue(
      GovernanceAccessResponseSchema.parse({
        ...envelope,
        kind: "governance-access-response",
        access: { administrator: true },
      }),
    ),
    centers: vi.fn().mockResolvedValue(
      GovernanceCentersResponseSchema.parse({
        ...envelope,
        kind: "governance-centers-response",
        items: [center(CENTER_A), center(CENTER_B)],
        nextAfterId: null,
      }),
    ),
    classes: vi.fn().mockImplementation(({ centerId }: { centerId: string }) =>
      Promise.resolve(
        GovernanceClassesResponseSchema.parse({
          ...envelope,
          kind: "governance-classes-response",
          items: [classroom(centerId === CENTER_A ? CLASS_A : CLASS_B, centerId)],
          nextAfterId: null,
        }),
      ),
    ),
    accounts: vi.fn().mockImplementation(({ centerId }: { centerId: string }) =>
      Promise.resolve(
        GovernanceAccountsResponseSchema.parse({
          ...envelope,
          kind: "governance-accounts-response",
          items: [account(centerId === CENTER_A ? USER_A : USER_B, centerId)],
          nextAfterId: null,
        }),
      ),
    ),
    memberships: vi.fn().mockResolvedValue(
      GovernanceMembershipsResponseSchema.parse({
        ...envelope,
        kind: "governance-memberships-response",
        items: [membership()],
        nextAfterId: null,
      }),
    ),
    classRevision: vi.fn().mockResolvedValue(
      GovernanceClassRevisionResponseSchema.parse({
        ...envelope,
        kind: "governance-class-revision-response",
        centerId: CENTER_A,
        classId: CLASS_A,
        teachingVersion: VERSION_A,
      }),
    ),
    createClass: vi.fn().mockResolvedValue(
      GovernanceClassCreatedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-created",
        classroom: classroom(),
      }),
    ),
    renameClass: vi.fn().mockResolvedValue(
      GovernanceClassRenamedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-renamed",
        classroom: classroom(CLASS_A, CENTER_A, "Renamed"),
      }),
    ),
    createAccount: vi.fn().mockResolvedValue(
      GovernanceAccountCreatedResponseSchema.parse({
        ...envelope,
        kind: "governance-account-created",
        account: account(),
      }),
    ),
    renameAccount: vi.fn().mockResolvedValue(
      GovernanceAccountRenamedResponseSchema.parse({
        ...envelope,
        kind: "governance-account-renamed",
        account: account(USER_A, CENTER_A, "Renamed"),
      }),
    ),
    changeAccountState: vi.fn().mockResolvedValue(
      GovernanceAccountStateChangedResponseSchema.parse({
        ...envelope,
        kind: "governance-account-state-changed",
        account: { ...account(), state: "disabled" },
      }),
    ),
    changeMembership: vi.fn().mockResolvedValue(
      GovernanceMembershipChangedResponseSchema.parse({
        ...envelope,
        kind: "governance-membership-changed",
        membership: membership(),
      }),
    ),
    revokeSessions: vi.fn().mockResolvedValue(
      GovernanceSessionsRevokedResponseSchema.parse({
        ...envelope,
        kind: "governance-sessions-revoked",
        revocation: { userId: USER_A, version: VERSION_B, revokedAt: "2099-01-01T00:00:00Z" },
      }),
    ),
    exportClass: vi.fn().mockResolvedValue(
      GovernanceClassExportedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-exported",
        package: exchange,
      }),
    ),
    previewClassImport: vi.fn().mockResolvedValue(
      GovernanceClassImportPreviewedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-import-previewed",
        preview: preview(),
      }),
    ),
    confirmClassImport: vi.fn().mockResolvedValue(
      GovernanceClassImportConfirmedResponseSchema.parse({
        ...envelope,
        kind: "governance-class-import-confirmed",
        classId: CLASS_A,
        teachingVersion: VERSION_B,
      }),
    ),
    cancelClassImport: vi.fn().mockResolvedValue(
      GovernanceClassImportCancelledResponseSchema.parse({
        ...envelope,
        kind: "governance-class-import-cancelled",
        previewId: PREVIEW_A,
      }),
    ),
  } satisfies GovernanceClient;
  return client;
}
