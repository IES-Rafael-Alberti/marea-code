import type {
  GovernanceAccessResponse,
  GovernanceCreateAccountResponse,
  GovernanceRenameAccountResponse,
  GovernanceChangeAccountStateResponse,
  GovernanceAccountsQuery,
  GovernanceAccountsResponse,
  GovernanceCancelClassImportRequest,
  GovernanceCancelClassImportResponse,
  GovernanceCentersQuery,
  GovernanceCentersResponse,
  GovernanceChangeAccountStateRequest,
  GovernanceChangeMembershipRequest,
  GovernanceCreateClassResponse,
  GovernanceExportClassResponse,
  GovernanceConfirmClassImportResponse,
  GovernancePreviewClassImportResponse,
  GovernanceClassRevisionQuery,
  GovernanceClassRevisionResponse,
  GovernanceRenameClassResponse,
  GovernanceClassesQuery,
  GovernanceClassesResponse,
  GovernanceCreateAccountRequest,
  GovernanceCreateClassRequest,
  GovernanceConfirmClassImportRequest,
  GovernanceExportClassRequest,
  GovernanceChangeMembershipResponse,
  GovernanceMembershipsQuery,
  GovernanceMembershipsResponse,
  GovernancePreviewClassImportRequest,
  GovernanceRenameAccountRequest,
  GovernanceRenameClassRequest,
  GovernanceRevokeSessionsRequest,
  GovernanceRevokeSessionsResponse,
} from "@marea/protocol";

type WithoutEnvelope<T> = Omit<T, "protocolVersion" | "requestId" | "kind">;

export type GovernanceCentersInput = WithoutEnvelope<GovernanceCentersQuery>;
export type GovernanceClassesInput = WithoutEnvelope<GovernanceClassesQuery>;
export type GovernanceAccountsInput = WithoutEnvelope<GovernanceAccountsQuery>;
export type GovernanceMembershipsInput = WithoutEnvelope<GovernanceMembershipsQuery>;
export type GovernanceClassRevisionInput = WithoutEnvelope<GovernanceClassRevisionQuery>;
export type GovernanceCreateClassInput = WithoutEnvelope<GovernanceCreateClassRequest>;
export type GovernanceRenameClassInput = WithoutEnvelope<GovernanceRenameClassRequest>;
export type GovernanceCreateAccountInput = WithoutEnvelope<GovernanceCreateAccountRequest>;
export type GovernanceRenameAccountInput = WithoutEnvelope<GovernanceRenameAccountRequest>;
export type GovernanceChangeAccountStateInput =
  WithoutEnvelope<GovernanceChangeAccountStateRequest>;
export type GovernanceChangeMembershipInput = WithoutEnvelope<GovernanceChangeMembershipRequest>;
export type GovernanceRevokeSessionsInput = WithoutEnvelope<GovernanceRevokeSessionsRequest>;
export type GovernanceExportClassInput = WithoutEnvelope<GovernanceExportClassRequest>;
export type GovernancePreviewClassImportInput =
  WithoutEnvelope<GovernancePreviewClassImportRequest>;
export type GovernanceConfirmClassImportInput =
  WithoutEnvelope<GovernanceConfirmClassImportRequest>;
export type GovernanceCancelClassImportInput = WithoutEnvelope<GovernanceCancelClassImportRequest>;

export type GovernanceProblem =
  | "load"
  | "invalid"
  | "forbidden"
  | "conflict"
  | "uncertain"
  | "unconfigured"
  | "skill-unavailable";

export interface GovernanceClientFailure extends Error {
  readonly code: GovernanceProblem;
}

export interface GovernanceClient {
  access(signal: AbortSignal): Promise<GovernanceAccessResponse>;
  centers(input: GovernanceCentersInput, signal: AbortSignal): Promise<GovernanceCentersResponse>;
  classes(input: GovernanceClassesInput, signal: AbortSignal): Promise<GovernanceClassesResponse>;
  accounts(
    input: GovernanceAccountsInput,
    signal: AbortSignal,
  ): Promise<GovernanceAccountsResponse>;
  memberships(
    input: GovernanceMembershipsInput,
    signal: AbortSignal,
  ): Promise<GovernanceMembershipsResponse>;
  classRevision(
    input: GovernanceClassRevisionInput,
    signal: AbortSignal,
  ): Promise<GovernanceClassRevisionResponse>;
  createClass(
    input: GovernanceCreateClassInput,
    signal: AbortSignal,
  ): Promise<GovernanceCreateClassResponse>;
  renameClass(
    input: GovernanceRenameClassInput,
    signal: AbortSignal,
  ): Promise<GovernanceRenameClassResponse>;
  createAccount(
    input: GovernanceCreateAccountInput,
    signal: AbortSignal,
  ): Promise<GovernanceCreateAccountResponse>;
  renameAccount(
    input: GovernanceRenameAccountInput,
    signal: AbortSignal,
  ): Promise<GovernanceRenameAccountResponse>;
  changeAccountState(
    input: GovernanceChangeAccountStateInput,
    signal: AbortSignal,
  ): Promise<GovernanceChangeAccountStateResponse>;
  changeMembership(
    input: GovernanceChangeMembershipInput,
    signal: AbortSignal,
  ): Promise<GovernanceChangeMembershipResponse>;
  revokeSessions(
    input: GovernanceRevokeSessionsInput,
    signal: AbortSignal,
  ): Promise<GovernanceRevokeSessionsResponse>;
  exportClass(
    input: GovernanceExportClassInput,
    signal: AbortSignal,
  ): Promise<GovernanceExportClassResponse>;
  previewClassImport(
    input: GovernancePreviewClassImportInput,
    signal: AbortSignal,
  ): Promise<GovernancePreviewClassImportResponse>;
  confirmClassImport(
    input: GovernanceConfirmClassImportInput,
    signal: AbortSignal,
  ): Promise<GovernanceConfirmClassImportResponse>;
  cancelClassImport(
    input: GovernanceCancelClassImportInput,
    signal: AbortSignal,
  ): Promise<GovernanceCancelClassImportResponse>;
}
