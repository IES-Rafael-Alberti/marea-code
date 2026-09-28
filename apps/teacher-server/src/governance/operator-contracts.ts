import type * as Protocol from "@marea/protocol";
import type { Id, OperatorContext, Version } from "./authority.js";
import type { AdoptionMap, AdoptionReceipt } from "./adoption-contracts.js";
import type { OperatorCenterAssociation } from "./contracts.js";
import type { TeachingOperatorPolicy } from "../teaching/configuration/dashboard-contracts.js";
import type {
  SkillOwnerIdentity,
  SkillSaveRequest,
} from "../teaching/authoring/authoring-validation.boundary.js";
import type { SkillBundle, SkillKind, SkillSummary } from "../teaching/skills/skill-source.js";

type Payload<T> = Omit<T, "protocolVersion" | "requestId" | "kind">;
type OperatorInput<T> = OperatorContext & Payload<T>;

/** Existing class-keyed operator document, with complete policies; no new registry. */
export interface OperatorPolicyDocument {
  readonly version: 1;
  readonly classes: readonly { readonly classId: Id; readonly policy: TeachingOperatorPolicy }[];
}
export interface OperatorPolicyReceipt {
  readonly classes: number;
}
export interface CredentialProvisionInput {
  readonly userId: Id;
  readonly expectedVersion: Version;
  /** Private prompt/stdin only. Hashing belongs to the application, outside SQL. */
  readonly password: string;
}
export type OperatorSkillReadOwner = SkillOwnerIdentity | { readonly source: "marea" };

/** Private-only application ports for OPERATOR.md; there is no browser actor switch.
 * Contexts come from exclusive installation composition. Inputs still undergo
 * strict validation, and authority is rechecked after async preparation.
 */
export interface GovernanceOperatorApplication {
  createCenter(
    input: OperatorContext & {
      readonly centerId: Id;
      readonly displayName: Protocol.Center["displayName"];
      readonly expectedVersion: null;
    },
  ): Promise<Protocol.Center>;
  renameCenter(
    input: OperatorContext & {
      readonly centerId: Id;
      readonly displayName: Protocol.Center["displayName"];
      readonly expectedVersion: Version;
    },
  ): Promise<Protocol.Center>;
  associateAccount(
    input: OperatorContext & {
      readonly userId: Id;
      readonly centerId: Id;
      readonly expectedVersion: null;
    },
  ): Promise<OperatorCenterAssociation>;
  setAdministrator(
    input: OperatorContext & {
      readonly userId: Id;
      readonly centerId: Id;
      readonly capability: "member" | "administrator";
      readonly expectedVersion: Version;
    },
  ): Promise<OperatorCenterAssociation>;
  provisionCredential(input: OperatorContext & CredentialProvisionInput): Promise<{
    readonly userId: Id;
    readonly version: Version;
  }>;
  previewAdoption(input: OperatorContext & { readonly map: AdoptionMap }): Promise<AdoptionReceipt>;
  confirmAdoption(
    input: OperatorContext & {
      readonly map: AdoptionMap;
      readonly digest: Protocol.Sha256Digest;
    },
  ): Promise<AdoptionReceipt>;
  createClass(
    input: OperatorInput<Protocol.GovernanceCreateClassRequest>,
  ): Promise<Protocol.GovernanceClass>;
  renameClass(
    input: OperatorInput<Protocol.GovernanceRenameClassRequest>,
  ): Promise<Protocol.GovernanceClass>;
  /** The application generates the inaccessible pending hash, never a CLI-supplied hash. */
  createAccount(
    input: OperatorInput<Protocol.GovernanceCreateAccountRequest>,
  ): Promise<Protocol.GovernanceAccount>;
  renameAccount(
    input: OperatorInput<Protocol.GovernanceRenameAccountRequest>,
  ): Promise<Protocol.GovernanceAccount>;
  changeAccountState(
    input: OperatorInput<Protocol.GovernanceChangeAccountStateRequest>,
  ): Promise<Protocol.GovernanceAccount>;
  changeMembership(
    input: OperatorInput<Protocol.GovernanceChangeMembershipRequest>,
  ): Promise<Protocol.Membership>;
  revokeSessions(
    input: OperatorInput<Protocol.GovernanceRevokeSessionsRequest>,
  ): Promise<Protocol.Revocation>;
  exportClass(
    input: OperatorInput<Protocol.GovernanceExportClassRequest>,
  ): Promise<Protocol.ClassExchange>;
  previewClassImport(
    input: OperatorInput<Protocol.GovernancePreviewClassImportRequest>,
  ): Promise<Protocol.ImportPreview>;
  confirmClassImport(input: OperatorInput<Protocol.GovernanceConfirmClassImportRequest>): Promise<{
    readonly classId: Id;
    readonly teachingVersion: Version;
  }>;
  cancelClassImport(
    input: OperatorInput<Protocol.GovernanceCancelClassImportRequest>,
  ): Promise<{ readonly previewId: Id }>;
  /** Validate via the existing operator parser and complete private policy rules. */
  validatePolicy(
    input: OperatorContext & { readonly document: OperatorPolicyDocument },
  ): Promise<OperatorPolicyReceipt>;
  /** Publishes a new private immutable file; never replaces or reloads a live policy. */
  publishPolicy(
    input: OperatorContext & {
      readonly document: OperatorPolicyDocument;
      readonly outputPath: string;
    },
  ): Promise<OperatorPolicyReceipt>;
  listSkills(
    input: OperatorContext & {
      readonly owner: OperatorSkillReadOwner;
      readonly kind: SkillKind;
    },
  ): Promise<readonly SkillSummary[]>;
  /** Private artifact content, never diagnostic stdout or a governance DTO. */
  readSkill(
    input: OperatorContext & {
      readonly owner: OperatorSkillReadOwner;
      readonly skillId: Protocol.SkillId;
    },
  ): Promise<SkillBundle | null>;
  validateSkill(
    input: OperatorContext & {
      readonly owner: SkillOwnerIdentity;
      readonly request: Omit<SkillSaveRequest, "expectedDigest">;
    },
  ): Promise<SkillBundle>;
  saveSkill(
    input: OperatorContext & {
      readonly owner: SkillOwnerIdentity;
      readonly request: SkillSaveRequest;
    },
  ): Promise<SkillSummary>;
}
