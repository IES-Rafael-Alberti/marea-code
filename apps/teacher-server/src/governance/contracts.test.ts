import { expectTypeOf, it } from "vitest";
import type * as P from "@marea/protocol";
import type {
  AdoptionReceipt,
  GovernanceAuthority,
  GovernanceCommitContext,
  GovernanceReadContext,
  GovernanceIdGenerator,
  GovernanceOperatorApplication,
  GovernanceRepository,
  GovernanceService,
  GovernanceSession,
  InstallationCapability,
  OperatorCommitContext,
  OperatorContext,
  PreparedClassImportConfirmation,
  PreparedClassImportPreview,
  StoredClassImportPreview,
} from "./index.js";
import type { StoredTeachingConfiguration } from "../teaching/configuration/configuration-schema.js";

interface WirePairs {
  access: [P.GovernanceAccessQuery, P.GovernanceAccessResponse];
  centers: [P.GovernanceCentersQuery, P.GovernanceCentersResponse];
  classes: [P.GovernanceClassesQuery, P.GovernanceClassesResponse];
  accounts: [P.GovernanceAccountsQuery, P.GovernanceAccountsResponse];
  memberships: [P.GovernanceMembershipsQuery, P.GovernanceMembershipsResponse];
  classRevision: [P.GovernanceClassRevisionQuery, P.GovernanceClassRevisionResponse];
  createClass: [P.GovernanceCreateClassRequest, P.GovernanceCreateClassResponse];
  renameClass: [P.GovernanceRenameClassRequest, P.GovernanceRenameClassResponse];
  createAccount: [P.GovernanceCreateAccountRequest, P.GovernanceCreateAccountResponse];
  renameAccount: [P.GovernanceRenameAccountRequest, P.GovernanceRenameAccountResponse];
  changeAccountState: [
    P.GovernanceChangeAccountStateRequest,
    P.GovernanceChangeAccountStateResponse,
  ];
  changeMembership: [P.GovernanceChangeMembershipRequest, P.GovernanceChangeMembershipResponse];
  revokeSessions: [P.GovernanceRevokeSessionsRequest, P.GovernanceRevokeSessionsResponse];
  exportClass: [P.GovernanceExportClassRequest, P.GovernanceExportClassResponse];
  previewClassImport: [
    P.GovernancePreviewClassImportRequest,
    P.GovernancePreviewClassImportResponse,
  ];
  confirmClassImport: [
    P.GovernanceConfirmClassImportRequest,
    P.GovernanceConfirmClassImportResponse,
  ];
  cancelClassImport: [P.GovernanceCancelClassImportRequest, P.GovernanceCancelClassImportResponse];
}
type ExpectedService = {
  [K in keyof WirePairs]: (
    session: GovernanceSession,
    request: WirePairs[K][0],
  ) => Promise<WirePairs[K][1]>;
};

it("has the exact inferred signature of every accepted HTTP operation", () => {
  expectTypeOf<GovernanceService>().toEqualTypeOf<ExpectedService>();
  expectTypeOf<P.GovernanceRequest["kind"]>().toExtend<`governance-${string}`>();
  expectTypeOf<P.GovernanceResponse["kind"]>().toExtend<`governance-${string}`>();
  expectTypeOf<
    Extract<P.GovernanceRequest["kind"], P.GovernanceResponse["kind"]>
  >().toEqualTypeOf<never>();
  expectTypeOf<keyof P.GovernanceCentersResponse>().toEqualTypeOf<
    "protocolVersion" | "requestId" | "kind" | "items" | "nextAfterId"
  >();
  expectTypeOf<Parameters<GovernanceIdGenerator["createId"]>[0]>().toEqualTypeOf<
    "revision" | "preview"
  >();
});

it("requires explicit live authority on reads and commits without a fake administrator session", () => {
  expectTypeOf<GovernanceCommitContext["requestId"]>().toEqualTypeOf<P.RequestId>();
  expectTypeOf<Extract<GovernanceAuthority, { kind: "operator" }>>().toEqualTypeOf<{
    readonly kind: "operator";
    readonly installation: InstallationCapability;
  }>();
  expectTypeOf<Extract<GovernanceAuthority, { kind: "administrator" }>>().toEqualTypeOf<{
    readonly kind: "administrator";
    readonly session: GovernanceSession;
  }>();
  expectTypeOf<
    Parameters<GovernanceRepository["listCenters"]>[0]
  >().toEqualTypeOf<GovernanceReadContext>();
  expectTypeOf<
    Parameters<GovernanceRepository["listAccounts"]>[0]
  >().toEqualTypeOf<GovernanceReadContext>();
  expectTypeOf<
    Parameters<GovernanceRepository["listClasses"]>[0]
  >().toEqualTypeOf<GovernanceReadContext>();
  expectTypeOf<
    Parameters<GovernanceRepository["listMemberships"]>[0]["context"]
  >().toEqualTypeOf<GovernanceReadContext>();
  expectTypeOf<OperatorCommitContext["authority"]>().toEqualTypeOf<InstallationCapability>();
  expectTypeOf<GovernanceSession>().not.toExtend<InstallationCapability>();
  expectTypeOf<P.GovernanceCreateClassRequest>().not.toExtend<GovernanceCommitContext>();
  expectTypeOf<{
    kind: "exclusive-installation-owner";
    installationRoot: string;
  }>().not.toExtend<InstallationCapability>();
  expectTypeOf<() => Promise<undefined>>().not.toExtend<InstallationCapability["assertOwned"]>();
  expectTypeOf<
    Extract<keyof GovernanceRepository, "transaction" | "save" | "execute">
  >().toEqualTypeOf<never>();
});

it("carries exact private preview binding and typed configuration to a synchronous atomic commit", () => {
  expectTypeOf<PreparedClassImportPreview["expectedClassVersion"]>().toEqualTypeOf<string>();
  expectTypeOf<PreparedClassImportPreview["operatorFingerprint"]>().toEqualTypeOf<P.Sha256Digest>();
  expectTypeOf<PreparedClassImportPreview["package"]>().toEqualTypeOf<P.ClassExchange>();
  expectTypeOf<PreparedClassImportPreview["settings"]>().toEqualTypeOf<P.TeachingSettings>();
  expectTypeOf<
    PreparedClassImportConfirmation["preview"]
  >().toEqualTypeOf<StoredClassImportPreview>();
  expectTypeOf<
    PreparedClassImportConfirmation["configuration"]
  >().toEqualTypeOf<StoredTeachingConfiguration>();
  expectTypeOf<() => Promise<undefined>>().not.toExtend<
    PreparedClassImportConfirmation["assertPublicationCurrent"]
  >();
  expectTypeOf<ReturnType<GovernanceRepository["commitClassImportConfirmation"]>>().toEqualTypeOf<{
    readonly classId: string;
    readonly teachingVersion: string;
  }>();
  expectTypeOf<
    Extract<keyof P.ImportPreview, "creator" | "operatorFingerprint" | "expectedClassVersion">
  >().toEqualTypeOf<never>();
  expectTypeOf<AdoptionReceipt["digest"]>().toEqualTypeOf<P.Sha256Digest>();
});

type OperatorKeys =
  | "createCenter"
  | "renameCenter"
  | "associateAccount"
  | "setAdministrator"
  | "provisionCredential"
  | "previewAdoption"
  | "confirmAdoption"
  | "createClass"
  | "renameClass"
  | "createAccount"
  | "renameAccount"
  | "changeAccountState"
  | "changeMembership"
  | "revokeSessions"
  | "exportClass"
  | "previewClassImport"
  | "confirmClassImport"
  | "cancelClassImport"
  | "validatePolicy"
  | "publishPolicy"
  | "listSkills"
  | "readSkill"
  | "validateSkill"
  | "saveSkill";
type OperatorInput = Parameters<GovernanceOperatorApplication[OperatorKeys]>[0];
type CommitKeys = Extract<keyof GovernanceRepository, `commit${string}`>;
type CommitResults = ReturnType<GovernanceRepository[CommitKeys]>;

it("completes the private operator inventory and leaves persistence commits synchronous", () => {
  expectTypeOf<keyof GovernanceOperatorApplication>().toEqualTypeOf<OperatorKeys>();
  expectTypeOf<OperatorInput>().toExtend<OperatorContext>();
  expectTypeOf<Extract<CommitResults, PromiseLike<object>>>().toEqualTypeOf<never>();
  expectTypeOf<
    Awaited<ReturnType<GovernanceOperatorApplication["previewClassImport"]>>
  >().toEqualTypeOf<P.ImportPreview>();
  expectTypeOf<
    Awaited<ReturnType<GovernanceOperatorApplication["confirmClassImport"]>>
  >().toEqualTypeOf<{
    readonly classId: string;
    readonly teachingVersion: string;
  }>();
  expectTypeOf<
    Parameters<GovernanceOperatorApplication["createCenter"]>[0]["expectedVersion"]
  >().toEqualTypeOf<null>();
  expectTypeOf<
    Extract<keyof Parameters<GovernanceOperatorApplication["createAccount"]>[0], "passwordHash">
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Parameters<GovernanceRepository["commitProvisionCredential"]>[0]["passwordHash"]
  >().toEqualTypeOf<string>();
  expectTypeOf<{ source: "marea" }>().not.toExtend<
    Parameters<GovernanceOperatorApplication["saveSkill"]>[0]["owner"]
  >();
});
