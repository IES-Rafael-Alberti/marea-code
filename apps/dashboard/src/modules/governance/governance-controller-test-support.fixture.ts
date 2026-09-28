import type {
  GovernanceAccount,
  GovernanceClass,
  GovernanceAccountsResponse,
  GovernanceClassesResponse,
} from "@marea/protocol";
import {
  GovernanceCentersResponseSchema,
  GovernanceClassRevisionResponseSchema,
  GovernanceMembershipsResponseSchema,
  RequestIdSchema,
} from "@marea/protocol";
import { expect, vi } from "vitest";

import type { GovernanceState } from "./governance-controller-contracts.js";
import { GovernanceController } from "./governance-controller.js";
import {
  CENTER_A,
  CLASS_A,
  CLASS_B,
  USER_A,
  USER_B,
  VERSION_A,
  account,
  classroom,
  controllerClient,
} from "./governance-controller.fixture.js";

export {
  CLASS_A,
  CLASS_B,
  CENTER_A,
  CENTER_B,
  USER_A,
  USER_B,
  VERSION_A,
  VERSION_B,
  account,
  classroom,
  controllerClient,
  exchange,
  preview,
} from "./governance-controller.fixture.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export async function openCenter(
  now: () => number = () => 0,
  client: ReturnType<typeof controllerClient> = controllerClient(),
) {
  const changed = vi.fn<(state: GovernanceState) => void>();
  const controller = new GovernanceController(client, changed, now);
  await controller.load();
  await controller.selectCenter(CENTER_A);
  return { changed, client, controller };
}

export async function openClass(now: () => number = () => 0) {
  const opened = await openCenter(now);
  await opened.controller.selectClass(CLASS_A);
  return opened;
}

const envelope = { protocolVersion: "0.1", requestId: "request:controller" } as const;

export function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export function centersResponse(ids: readonly string[], nextAfterId: string | null = null) {
  return GovernanceCentersResponseSchema.parse({
    ...envelope,
    kind: "governance-centers-response",
    items: ids.map((centerId) => ({ centerId, displayName: "Center", version: VERSION_A })),
    nextAfterId,
  });
}

export function membership(
  userId: string,
  state: "active" | "revoked" = "active",
  classId: string = CLASS_A,
  centerId: string = CENTER_A,
) {
  return { userId, classId, centerId, role: "teacher" as const, state, version: VERSION_A };
}

export function membershipsResponse(
  items: readonly ReturnType<typeof membership>[],
  nextAfterId: string | null = null,
) {
  return GovernanceMembershipsResponseSchema.parse({
    ...envelope,
    kind: "governance-memberships-response",
    items,
    nextAfterId,
  });
}

export function revisionResponse(
  teachingVersion: string | null,
  classId: string = CLASS_A,
  centerId: string = CENTER_A,
) {
  return GovernanceClassRevisionResponseSchema.parse({
    ...envelope,
    kind: "governance-class-revision-response",
    centerId,
    classId,
    teachingVersion,
  });
}

export const clearedPresentationFields = [
  "access",
  "centerId",
  "classId",
  "accountId",
  "currentTeachingVersion",
  "classDraft",
  "classRecovery",
  "classCreateDraft",
  "classCreateRecovery",
  "accountDraft",
  "accountRecovery",
  "accountCreateDraft",
  "accountCreateRecovery",
  "importPreviewReviewedId",
  "exportedPackage",
  "importPackage",
  "importPreview",
  "lastRevocation",
  "pendingCenterId",
  "pendingClassId",
  "pendingAccountId",
] as const;

export function classesResponse(items: GovernanceClass[]): GovernanceClassesResponse {
  return {
    protocolVersion: "0.1",
    requestId: RequestIdSchema.parse("request:controller"),
    kind: "governance-classes-response",
    items,
    nextAfterId: null,
  };
}

export function accountsResponse(items: GovernanceAccount[]): GovernanceAccountsResponse {
  return {
    protocolVersion: "0.1",
    requestId: RequestIdSchema.parse("request:controller"),
    kind: "governance-accounts-response",
    items,
    nextAfterId: null,
  };
}

export function expectEmptyPrivateCollections(state: GovernanceState): void {
  expect(state.centers).toEqual([]);
  expect(state.classes).toEqual([]);
  expect(state.accounts).toEqual([]);
  expect(state.memberships).toEqual([]);
  expect(state.importPreviewExpired).toBe(false);
}

/** Center A with two listed classes and accounts; scoped reads echo the requested identity. */
export async function openTwoClassCenter(now: () => number = () => 0) {
  const client = controllerClient();
  client.classes.mockResolvedValue(classesResponse([classroom(CLASS_A), classroom(CLASS_B)]));
  client.accounts.mockResolvedValue(accountsResponse([account(USER_A), account(USER_B)]));
  client.memberships.mockImplementation(
    ({ centerId, classId }: { centerId: string; classId: string }) =>
      Promise.resolve(membershipsResponse([membership(USER_A, "active", classId, centerId)])),
  );
  client.classRevision.mockImplementation(
    ({ centerId, classId }: { centerId: string; classId: string }) =>
      Promise.resolve(revisionResponse(VERSION_A, classId, centerId)),
  );
  return openCenter(now, client);
}
