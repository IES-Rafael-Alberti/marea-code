import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type {
  Center,
  ClassExchange,
  GovernanceAccount,
  GovernanceAccessQuery,
  GovernanceAccountsQuery,
  GovernanceAccountsResponse,
  GovernanceCancelClassImportRequest,
  GovernanceCancelClassImportResponse,
  GovernanceChangeAccountStateRequest,
  GovernanceChangeAccountStateResponse,
  GovernanceChangeMembershipRequest,
  GovernanceChangeMembershipResponse,
  GovernanceClassesQuery,
  GovernanceClassesResponse,
  GovernanceClass,
  GovernanceClassRevisionQuery,
  GovernanceClassRevisionResponse,
  GovernanceExportClassRequest,
  GovernanceConfirmClassImportResponse,
  GovernancePreviewClassImportResponse,
  GovernanceConfirmClassImportRequest,
  GovernanceCreateAccountRequest,
  GovernanceCreateAccountResponse,
  GovernanceCreateClassRequest,
  GovernanceCreateClassResponse,
  GovernanceExportClassResponse,
  GovernanceMembershipsQuery,
  GovernanceMembershipsResponse,
  GovernancePage,
  GovernancePreviewClassImportRequest,
  GovernanceRenameAccountRequest,
  GovernanceRenameAccountResponse,
  GovernanceRenameClassRequest,
  GovernanceRenameClassResponse,
  GovernanceRevokeSessionsRequest,
  GovernanceRevokeSessionsResponse,
  GovernanceAccessResponse,
  GovernanceCentersQuery,
  GovernanceCentersResponse,
  ImportPreview,
  Membership,
  Revocation,
  TeachingSettings,
  Sha256Digest,
} from "@marea/protocol";
import type {
  GovernanceCommitContext,
  GovernanceReadContext,
  GovernanceSession,
  Id,
  Time,
  Version,
  InstallationCapability,
} from "./authority.js";
import type { AdoptionMap, AdoptionReceipt } from "./adoption-contracts.js";
import type { StoredTeachingConfiguration } from "../teaching/configuration/configuration-schema.js";

export interface PreparedCreateClass {
  readonly context: GovernanceCommitContext;
  readonly centerId: Id;
  readonly classId: Id;
  readonly displayName: GovernanceCreateClassRequest["displayName"];
}
export interface PreparedRenameClass {
  readonly context: GovernanceCommitContext;
  readonly centerId: Id;
  readonly classId: Id;
  readonly displayName: GovernanceRenameClassRequest["displayName"];
  readonly expectedVersion: GovernanceRenameClassRequest["expectedVersion"];
}
export interface PreparedCreateAccount {
  readonly context: GovernanceCommitContext;
  readonly centerId: Id;
  readonly userId: Id;
  readonly displayName: GovernanceCreateAccountRequest["displayName"];
  readonly login: GovernanceCreateAccountRequest["login"];
  readonly role: GovernanceCreateAccountRequest["role"];
  readonly classId: GovernanceCreateAccountRequest["classId"];
  readonly passwordHash: string;
}
export interface PreparedRenameAccount {
  readonly context: GovernanceCommitContext;
  readonly centerId: Id;
  readonly userId: Id;
  readonly displayName: GovernanceRenameAccountRequest["displayName"];
  readonly expectedVersion: GovernanceRenameAccountRequest["expectedVersion"];
}
export interface PreparedChangeAccountState {
  readonly context: GovernanceCommitContext;
  readonly centerId: Id;
  readonly userId: Id;
  readonly state: GovernanceChangeAccountStateRequest["state"];
  readonly expectedVersion: GovernanceChangeAccountStateRequest["expectedVersion"];
}
export interface PreparedChangeMembership {
  readonly context: GovernanceCommitContext;
  readonly centerId: Id;
  readonly classId: Id;
  readonly userId: Id;
  readonly state: GovernanceChangeMembershipRequest["state"];
  readonly expectedVersion: GovernanceChangeMembershipRequest["expectedVersion"];
}
export interface PreparedRevokeSessions {
  readonly context: GovernanceCommitContext;
  readonly centerId: Id;
  readonly userId: Id;
  readonly expectedVersion: GovernanceRevokeSessionsRequest["expectedVersion"];
}
export interface PreparedClassImportPreview {
  readonly context: GovernanceCommitContext;
  readonly centerId: Id;
  readonly classId: Id;
  readonly expectedTeachingVersion: GovernancePreviewClassImportRequest["expectedTeachingVersion"];
  readonly expectedClassVersion: Version;
  readonly operatorFingerprint: Sha256Digest;
  readonly packageDigest: ImportPreview["packageDigest"];
  readonly package: ClassExchange;
  readonly settings: TeachingSettings;
  readonly expiresAt: Time;
  readonly previewId: Id;
  /** Prepared under the source coordination gate; called again inside commit. */
  readonly assertPublicationCurrent: () => undefined;
}

export interface GovernanceClassScope {
  readonly context: GovernanceReadContext;
  readonly centerId: Id;
  readonly classId: Id;
}
export interface GovernanceClassExchangeState {
  readonly classroom: GovernanceClass;
  readonly teachingVersion: Version | null;
  readonly settings: TeachingSettings | null;
}
/** Only pending, currently authorized previews are returned to the private service. */
export interface StoredClassImportPreview {
  readonly previewId: Id;
  readonly centerId: Id;
  readonly classId: Id;
  readonly creator:
    | { readonly kind: "administrator"; readonly userId: Id; readonly sessionId: Id }
    | { readonly kind: "operator" };
  readonly createdAt: Time;
  readonly expiresAt: Time;
  readonly expectedTeachingVersion: Version | null;
  readonly expectedClassVersion: Version;
  readonly operatorFingerprint: Sha256Digest;
  readonly packageDigest: Sha256Digest;
  readonly package: ClassExchange;
  readonly settings: TeachingSettings;
}
export interface PreparedClassImportConfirmation {
  readonly context: GovernanceCommitContext;
  readonly preview: StoredClassImportPreview;
  /** Typed materialized private content, never an arbitrary JSON persistence bag. */
  readonly configuration: StoredTeachingConfiguration;
  /** Recheck policy/source fingerprint and ownership synchronously under the gate. */
  readonly assertPublicationCurrent: () => undefined;
}
export interface OperatorCommitContext {
  readonly authority: InstallationCapability;
  readonly now: Time;
  readonly requestId: GovernanceCommitContext["requestId"];
  readonly generatedVersion: Version;
}
export interface OperatorCenterAssociation {
  readonly centerId: Id;
  readonly userId: Id;
  readonly capability: "member" | "administrator";
  readonly state: "active";
  readonly version: Version;
}

/** Each commit owns its immediate transaction, including live authorization and audit.
 * No generic transaction callback or SQL escape hatch is exposed to async services.
 */
export interface GovernanceRepository {
  requireSession(sessionId: Id, userId: Id, now: Time): AuthenticatedIdentity;
  requireAdministrator(sessionId: Id, centerId: Id, now: Time): void;
  requireAccess(context: GovernanceReadContext): GovernanceAccessResponse["access"];
  listCenters(context: GovernanceReadContext, afterId: Id | null): GovernancePage<Center>;
  listClasses(
    context: GovernanceReadContext,
    centerId: Id,
    afterId: Id | null,
  ): GovernancePage<GovernanceClass>;
  listAccounts(
    context: GovernanceReadContext,
    centerId: Id,
    afterId: Id | null,
  ): GovernancePage<GovernanceAccount>;
  listMemberships(scope: GovernanceClassScope, afterId: Id | null): GovernancePage<Membership>;
  loadClassForExchange(scope: GovernanceClassScope): GovernanceClassExchangeState;
  loadPendingClassImport(scope: GovernanceClassScope, previewId: Id): StoredClassImportPreview;
  commitCreateClass(input: PreparedCreateClass): GovernanceClass;
  commitRenameClass(input: PreparedRenameClass): GovernanceClass;
  commitCreateAccount(input: PreparedCreateAccount): GovernanceAccount;
  commitRenameAccount(input: PreparedRenameAccount): GovernanceAccount;
  commitChangeAccountState(input: PreparedChangeAccountState): GovernanceAccount;
  commitChangeMembership(input: PreparedChangeMembership): Membership;
  commitRevokeSessions(input: PreparedRevokeSessions): Revocation;
  commitClassImportPreview(input: PreparedClassImportPreview): ImportPreview;
  commitClassImportConfirmation(input: PreparedClassImportConfirmation): {
    readonly classId: Id;
    readonly teachingVersion: Version;
  };
  commitClassImportCancellation(input: {
    readonly context: GovernanceCommitContext;
    readonly centerId: Id;
    readonly classId: Id;
    readonly previewId: Id;
  }): { readonly previewId: Id };
  commitCreateCenter(input: {
    readonly context: OperatorCommitContext;
    readonly centerId: Id;
    readonly displayName: Center["displayName"];
    readonly expectedVersion: null;
  }): Center;
  commitRenameCenter(input: {
    readonly context: OperatorCommitContext;
    readonly centerId: Id;
    readonly displayName: Center["displayName"];
    readonly expectedVersion: Version;
  }): Center;
  commitAssociateAccount(input: {
    readonly context: OperatorCommitContext;
    readonly centerId: Id;
    readonly userId: Id;
    readonly expectedVersion: null;
  }): OperatorCenterAssociation;
  commitSetAdministrator(input: {
    readonly context: OperatorCommitContext;
    readonly centerId: Id;
    readonly userId: Id;
    readonly capability: "member" | "administrator";
    readonly expectedVersion: Version;
  }): OperatorCenterAssociation;
  commitProvisionCredential(input: {
    readonly context: OperatorCommitContext;
    readonly userId: Id;
    readonly expectedVersion: Version;
    readonly passwordHash: string;
  }): { readonly userId: Id; readonly version: Version };
  previewAdoption(input: {
    readonly authority: InstallationCapability;
    readonly now: Time;
    readonly map: AdoptionMap;
  }): AdoptionReceipt;
  commitAdoption(input: {
    readonly context: OperatorCommitContext;
    readonly map: AdoptionMap;
    readonly expectedInventoryDigest: Sha256Digest;
  }): AdoptionReceipt;
}

export interface GovernanceService {
  access(
    session: GovernanceSession,
    request: GovernanceAccessQuery,
  ): Promise<GovernanceAccessResponse>;
  centers(
    session: GovernanceSession,
    request: GovernanceCentersQuery,
  ): Promise<GovernanceCentersResponse>;
  classes(
    session: GovernanceSession,
    request: GovernanceClassesQuery,
  ): Promise<GovernanceClassesResponse>;
  accounts(
    session: GovernanceSession,
    request: GovernanceAccountsQuery,
  ): Promise<GovernanceAccountsResponse>;
  memberships(
    session: GovernanceSession,
    request: GovernanceMembershipsQuery,
  ): Promise<GovernanceMembershipsResponse>;
  classRevision(
    session: GovernanceSession,
    request: GovernanceClassRevisionQuery,
  ): Promise<GovernanceClassRevisionResponse>;
  createClass(
    session: GovernanceSession,
    request: GovernanceCreateClassRequest,
  ): Promise<GovernanceCreateClassResponse>;
  renameClass(
    session: GovernanceSession,
    request: GovernanceRenameClassRequest,
  ): Promise<GovernanceRenameClassResponse>;
  createAccount(
    session: GovernanceSession,
    request: GovernanceCreateAccountRequest,
  ): Promise<GovernanceCreateAccountResponse>;
  renameAccount(
    session: GovernanceSession,
    request: GovernanceRenameAccountRequest,
  ): Promise<GovernanceRenameAccountResponse>;
  changeAccountState(
    session: GovernanceSession,
    request: GovernanceChangeAccountStateRequest,
  ): Promise<GovernanceChangeAccountStateResponse>;
  changeMembership(
    session: GovernanceSession,
    request: GovernanceChangeMembershipRequest,
  ): Promise<GovernanceChangeMembershipResponse>;
  revokeSessions(
    session: GovernanceSession,
    request: GovernanceRevokeSessionsRequest,
  ): Promise<GovernanceRevokeSessionsResponse>;
  exportClass(
    session: GovernanceSession,
    request: GovernanceExportClassRequest,
  ): Promise<GovernanceExportClassResponse>;
  previewClassImport(
    session: GovernanceSession,
    request: GovernancePreviewClassImportRequest,
  ): Promise<GovernancePreviewClassImportResponse>;
  confirmClassImport(
    session: GovernanceSession,
    request: GovernanceConfirmClassImportRequest,
  ): Promise<GovernanceConfirmClassImportResponse>;
  cancelClassImport(
    session: GovernanceSession,
    request: GovernanceCancelClassImportRequest,
  ): Promise<GovernanceCancelClassImportResponse>;
}
