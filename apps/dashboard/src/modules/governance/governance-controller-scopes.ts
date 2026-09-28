import type { GovernanceState } from "./governance-controller-contracts.js";

export function clearedAccountScope(): Partial<GovernanceState> {
  return {
    accountId: null,
    accountDraft: null,
    accountRecovery: null,
    accountCreateDraft: null,
    accountCreateRecovery: null,
    lastRevocation: null,
    pendingAccountId: null,
  };
}

export function clearedClassScope(): Partial<GovernanceState> {
  return {
    classId: null,
    memberships: [],
    membershipsLoaded: false,
    classRevisionLoaded: false,
    currentTeachingVersion: null,
    classDraft: null,
    classRecovery: null,
    classCreateDraft: null,
    classCreateRecovery: null,
    importPackage: null,
    importPreview: null,
    importPreviewReviewedId: null,
    importPreviewExpired: false,
    exportedPackage: null,
    lastRevocation: null,
  };
}

export function resetClassSelection(): Partial<GovernanceState> {
  return {
    ...clearedClassScope(),
    ...clearedAccountScope(),
    pendingClassId: null,
  };
}

export function resetCenterScope(centerId: string | null): Partial<GovernanceState> {
  return {
    centerId,
    classes: [],
    classesLoaded: false,
    accounts: [],
    accountsLoaded: false,
    ...clearedAccountScope(),
    ...clearedClassScope(),
    pendingCenterId: null,
    pendingClassId: null,
    pendingAccountId: null,
  };
}
