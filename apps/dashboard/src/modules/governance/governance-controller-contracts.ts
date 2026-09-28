import type {
  Center,
  ClassExchange,
  GovernanceAccess,
  GovernanceAccount,
  GovernanceClass,
  ImportPreview,
  Membership,
  Revocation,
} from "@marea/protocol";

import type { GovernanceAccountCreateInput } from "./governance-controller-types.js";
import type { GovernanceClient, GovernanceProblem } from "./governance-contracts.js";

export interface GovernanceClassDraft {
  readonly centerId: string;
  readonly classId: string;
  readonly displayName: string;
  readonly expectedVersion: string;
}

export interface GovernanceAccountDraft {
  readonly centerId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly expectedVersion: string;
}

export interface GovernanceClassCreateDraft {
  readonly centerId: string;
  readonly classId: string;
  readonly displayName: string;
}

export interface GovernanceAccountCreateDraft extends GovernanceAccountCreateInput {
  readonly centerId: string;
}

/** View-facing capability hints; every write is still rechecked by the server. */
export interface GovernanceActionAvailability {
  readonly canSelectCenter: boolean;
  readonly canManageClasses: boolean;
  readonly canManageAccounts: boolean;
  readonly canManageMemberships: boolean;
  readonly canExchangeClass: boolean;
}

export interface GovernanceState {
  readonly busy: boolean;
  readonly availability: GovernanceActionAvailability;
  readonly access: GovernanceAccess | null;
  readonly centers: readonly Center[];
  readonly centersLoaded: boolean;
  readonly centerId: string | null;
  readonly classes: readonly GovernanceClass[];
  readonly classesLoaded: boolean;
  readonly classId: string | null;
  readonly accounts: readonly GovernanceAccount[];
  readonly accountsLoaded: boolean;
  readonly accountId: string | null;
  readonly memberships: readonly Membership[];
  readonly membershipsLoaded: boolean;
  readonly classRevisionLoaded: boolean;
  /** Null is a loaded, authorized class with no current teaching revision. */
  readonly currentTeachingVersion: string | null;
  readonly classDraft: GovernanceClassDraft | null;
  /** Server row read during reload; adopting it is always explicit. */
  readonly classRecovery: GovernanceClass | null;
  readonly classCreateDraft: GovernanceClassCreateDraft | null;
  readonly classCreateRecovery: GovernanceClass | null;
  readonly accountDraft: GovernanceAccountDraft | null;
  /** Server row read during reload; adopting it is always explicit. */
  readonly accountRecovery: GovernanceAccount | null;
  readonly accountCreateDraft: GovernanceAccountCreateDraft | null;
  readonly accountCreateRecovery: GovernanceAccount | null;
  /** Every retained create draft of the selected center, visible or hidden by navigation. */
  readonly pendingClassCreates: readonly GovernanceClassCreateDraft[];
  readonly pendingAccountCreates: readonly GovernanceAccountCreateDraft[];
  /** A preview is confirmable only while this reviewed ID is visible/current. */
  readonly importPreviewReviewedId: string | null;
  readonly exportedPackage: ClassExchange | null;
  readonly importPackage: ClassExchange | null;
  readonly importPreview: ImportPreview | null;
  readonly importPreviewExpired: boolean;
  readonly lastRevocation: Revocation | null;
  readonly pendingCenterId: string | null;
  readonly pendingClassId: string | null;
  readonly pendingAccountId: string | null;
  readonly problem: GovernanceProblem | null;
}

export interface GovernanceControllerActions {
  load(): Promise<void>;
  loadAccess(): Promise<void>;
  loadCenters(): Promise<void>;
  selectCenter(centerId: string): Promise<void>;
  confirmCenterSwitch(discard: boolean): Promise<void>;
  loadClasses(): Promise<void>;
  loadAccounts(): Promise<void>;
  selectClass(classId: string): Promise<void>;
  confirmClassSwitch(discard: boolean): Promise<void>;
  loadMemberships(): Promise<void>;
  loadClassRevision(): Promise<void>;
  selectAccount(userId: string): void;
  confirmAccountSwitch(discard: boolean): void;
  editClass(displayName: string): void;
  createClass(classId: string, displayName: string): Promise<void>;
  renameClass(): Promise<void>;
  editAccount(displayName: string): void;
  createAccount(input: GovernanceAccountCreateInput): Promise<void>;
  renameAccount(): Promise<void>;
  changeAccountState(state: "active" | "disabled"): Promise<void>;
  changeMembership(userId: string, state: "active" | "revoked"): Promise<void>;
  revokeSessions(): Promise<void>;
  exportClass(): Promise<void>;
  setImportPackage(value: ClassExchange | null): void;
  /** Stages pasted package text; unreadable text reports `invalid` and keeps the current package. */
  stageImportText(text: string): void;
  previewClassImport(): Promise<void>;
  confirmClassImport(): Promise<void>;
  cancelClassImport(): Promise<void>;
  reload(): Promise<void>;
  acceptReadback(): void;
  resumeClassCreateDraft(centerId: string, classId: string): void;
  dismissClassCreateDraft(centerId: string, classId: string): void;
  resumeAccountCreateDraft(centerId: string, userId: string): void;
  dismissAccountCreateDraft(centerId: string, userId: string): void;
  dispose(): void;
}

/** Public constructor contract kept separate from the frozen transport contract. */
export type GovernanceControllerClient = GovernanceClient;
