import * as z from "zod";
import { boundedGovernanceDocument } from "./governance-document.boundary.js";

import { CredentialLoginSchema, PrincipalRoleSchema } from "./auth.js";
import { RequestIdSchema } from "./identifiers.js";
import { AgentModeSchema, Sha256DigestSchema, UtcTimestampSchema } from "./runs.js";
import {
  ClassInstructionsSchema,
  TeachingSelectionSchema,
  TeachingSettingsSchema,
  MAX_TEACHING_CONFIGURATION_BYTES,
} from "./teaching-configuration.js";
import { RevisionIdSchema, SafeDisplayNameSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

/** Technical transport bounds; callers must enforce these while streaming bytes. */
export const MAX_GOVERNANCE_REQUEST_BYTES = 64 * 1_024;
export const MAX_GOVERNANCE_RESPONSE_BYTES = 256 * 1_024;
export const MAX_GOVERNANCE_PAGE_SIZE = 100;
export const MAX_IMPORT_PREVIEW_SECONDS = 10 * 60;
export const MAX_PENDING_PREVIEWS_PER_ACCOUNT = 20;
export const MAX_PENDING_PREVIEWS_PER_INSTALLATION = 1_000;

const envelope = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
};
const id = RevisionIdSchema;
const after = { afterId: id.nullable() };
const scope = { centerId: id };
const edit = { expectedVersion: id };
const create = { expectedVersion: z.null() };

function noNulOrSurrogate(value: string): boolean {
  return !value.includes("\0") && !/[\ud800-\udfff]/u.test(value);
}
export const CenterSchema = z
  .object({
    centerId: id,
    displayName: SafeDisplayNameSchema,
    version: id,
  })
  .strict()
  .readonly();

export const GovernanceClassSchema = z
  .object({
    classId: id,
    centerId: id,
    displayName: SafeDisplayNameSchema,
    version: id,
    operatorReady: z.boolean(),
  })
  .strict()
  .readonly();

export const GovernanceAccountSchema = z
  .object({
    userId: id,
    centerId: id,
    displayName: SafeDisplayNameSchema,
    role: PrincipalRoleSchema,
    state: z.enum(["pending", "active", "disabled"]),
    version: id,
    canManageAccount: z.boolean(),
  })
  .strict()
  .readonly();

export const MembershipSchema = z
  .object({
    classId: id,
    centerId: id,
    userId: id,
    role: PrincipalRoleSchema,
    state: z.enum(["active", "revoked"]),
    version: id,
  })
  .strict()
  .readonly();

export const GovernanceAccessSchema = z
  .object({ administrator: z.literal(true) })
  .strict()
  .readonly();
export const RevocationSchema = z
  .object({
    userId: id,
    version: id,
    revokedAt: UtcTimestampSchema,
  })
  .strict()
  .readonly();

const pageFields = <T extends z.ZodType>(item: T) => ({
  items: z.array(item).max(MAX_GOVERNANCE_PAGE_SIZE).readonly(),
  nextAfterId: id.nullable(),
});
export const GovernancePageSchema = <T extends z.ZodType>(item: T) =>
  z.object(pageFields(item)).strict().readonly();

export const ClassExchangeSchema = z
  .object({
    format: z.literal("marea-class-exchange:1"),
    source: z.object({ displayName: SafeDisplayNameSchema }).strict().readonly(),
    agentMode: AgentModeSchema,
    classInstructions: ClassInstructionsSchema,
    selection: TeachingSelectionSchema,
  })
  .superRefine((value, context) => {
    if (!noNulOrSurrogate(value.classInstructions.tutoring)) {
      context.addIssue({
        code: "custom",
        path: ["classInstructions", "tutoring"],
        message: "Invalid text.",
      });
    }
    if (!noNulOrSurrogate(value.classInstructions.free)) {
      context.addIssue({
        code: "custom",
        path: ["classInstructions", "free"],
        message: "Invalid text.",
      });
    }
  })
  .strict()
  .readonly();

export const ImportPreviewSchema = z
  .object({
    previewId: id,
    centerId: id,
    classId: id,
    expectedTeachingVersion: id.nullable(),
    expiresAt: UtcTimestampSchema,
    packageDigest: Sha256DigestSchema,
    settings: TeachingSettingsSchema.refine(
      (value) =>
        noNulOrSurrogate(value.classInstructions.tutoring) &&
        noNulOrSurrogate(value.classInstructions.free),
      "Invalid text.",
    ),
    preservesDestinationEvaluationPolicy: z.literal(true),
  })
  .strict()
  .readonly();

function request<K extends string, T extends z.ZodRawShape>(kind: K, payload: T) {
  return z
    .object({ ...envelope, kind: z.literal(`governance-${kind}`), ...payload })
    .strict()
    .readonly();
}
function response<K extends string, T extends z.ZodRawShape>(kind: K, payload: T) {
  return z
    .object({ ...envelope, kind: z.literal(`governance-${kind}`), ...payload })
    .strict()
    .readonly();
}

export const GovernanceAccessQuerySchema = request("access-query", {});
export const GovernanceCentersQuerySchema = request("centers-query", after);
export const GovernanceClassesQuerySchema = request("classes-query", { ...scope, ...after });
export const GovernanceAccountsQuerySchema = request("accounts-query", { ...scope, ...after });
export const GovernanceMembershipsQuerySchema = request("memberships-query", {
  ...scope,
  classId: id,
  ...after,
});
export const GovernanceClassRevisionQuerySchema = request("class-revision-query", {
  ...scope,
  classId: id,
});
export const GovernanceCreateClassRequestSchema = request("class-create", {
  ...scope,
  classId: id,
  displayName: SafeDisplayNameSchema,
  ...create,
});
export const GovernanceRenameClassRequestSchema = request("class-rename", {
  ...scope,
  classId: id,
  displayName: SafeDisplayNameSchema,
  ...edit,
});
export const GovernanceCreateAccountRequestSchema = request("account-create", {
  ...scope,
  userId: id,
  displayName: SafeDisplayNameSchema,
  login: CredentialLoginSchema,
  role: PrincipalRoleSchema,
  classId: id.nullable(),
  ...create,
}).refine((value) => value.role !== "student" || value.classId !== null);
export const GovernanceRenameAccountRequestSchema = request("account-rename", {
  ...scope,
  userId: id,
  displayName: SafeDisplayNameSchema,
  ...edit,
});
export const GovernanceChangeAccountStateRequestSchema = request("account-state-change", {
  ...scope,
  userId: id,
  state: z.enum(["active", "disabled"]),
  ...edit,
});
export const GovernanceChangeMembershipRequestSchema = request("membership-change", {
  ...scope,
  classId: id,
  userId: id,
  state: z.enum(["active", "revoked"]),
  expectedVersion: id.nullable(),
}).refine((value) => value.expectedVersion !== null || value.state === "active");
export const GovernanceRevokeSessionsRequestSchema = request("sessions-revoke", {
  ...scope,
  userId: id,
  ...edit,
});
export const GovernanceExportClassRequestSchema = request("class-export", {
  ...scope,
  classId: id,
  expectedTeachingVersion: id,
});
export const GovernancePreviewClassImportRequestSchema = request("class-import-preview", {
  ...scope,
  classId: id,
  expectedTeachingVersion: id.nullable(),
  package: ClassExchangeSchema,
});
export const GovernanceConfirmClassImportRequestSchema = request("class-import-confirm", {
  ...scope,
  classId: id,
  previewId: id,
});
export const GovernanceCancelClassImportRequestSchema = request("class-import-cancel", {
  ...scope,
  classId: id,
  previewId: id,
});

export const GovernanceAccessResponseSchema = response("access-response", {
  access: GovernanceAccessSchema,
});
export const GovernanceCentersResponseSchema = response("centers-response", {
  ...pageFields(CenterSchema),
});
export const GovernanceClassesResponseSchema = response("classes-response", {
  ...pageFields(GovernanceClassSchema),
});
export const GovernanceAccountsResponseSchema = response("accounts-response", {
  ...pageFields(GovernanceAccountSchema),
});
export const GovernanceMembershipsResponseSchema = response("memberships-response", {
  ...pageFields(MembershipSchema),
});
export const GovernanceClassRevisionResponseSchema = response("class-revision-response", {
  centerId: id,
  classId: id,
  teachingVersion: id.nullable(),
});
export const GovernanceClassCreatedResponseSchema = response("class-created", {
  classroom: GovernanceClassSchema,
});
export const GovernanceClassRenamedResponseSchema = response("class-renamed", {
  classroom: GovernanceClassSchema,
});
export const GovernanceAccountCreatedResponseSchema = response("account-created", {
  account: GovernanceAccountSchema,
});
export const GovernanceAccountRenamedResponseSchema = response("account-renamed", {
  account: GovernanceAccountSchema,
});
export const GovernanceAccountStateChangedResponseSchema = response("account-state-changed", {
  account: GovernanceAccountSchema,
});
export const GovernanceMembershipChangedResponseSchema = response("membership-changed", {
  membership: MembershipSchema,
});
export const GovernanceSessionsRevokedResponseSchema = response("sessions-revoked", {
  revocation: RevocationSchema,
});
export const GovernanceClassExportedResponseSchema = response("class-exported", {
  package: ClassExchangeSchema,
});
export const GovernanceClassImportPreviewedResponseSchema = response("class-import-previewed", {
  preview: ImportPreviewSchema,
});
export const GovernanceClassImportConfirmedResponseSchema = response("class-import-confirmed", {
  classId: id,
  teachingVersion: id,
});
export const GovernanceClassImportCancelledResponseSchema = response("class-import-cancelled", {
  previewId: id,
});

export const GovernanceRequestSchema = z.discriminatedUnion("kind", [
  GovernanceAccessQuerySchema,
  GovernanceCentersQuerySchema,
  GovernanceClassesQuerySchema,
  GovernanceAccountsQuerySchema,
  GovernanceMembershipsQuerySchema,
  GovernanceClassRevisionQuerySchema,
  GovernanceCreateClassRequestSchema,
  GovernanceRenameClassRequestSchema,
  GovernanceCreateAccountRequestSchema,
  GovernanceRenameAccountRequestSchema,
  GovernanceChangeAccountStateRequestSchema,
  GovernanceChangeMembershipRequestSchema,
  GovernanceRevokeSessionsRequestSchema,
  GovernanceExportClassRequestSchema,
  GovernancePreviewClassImportRequestSchema,
  GovernanceConfirmClassImportRequestSchema,
  GovernanceCancelClassImportRequestSchema,
]);
export const GovernanceResponseSchema = z.discriminatedUnion("kind", [
  GovernanceAccessResponseSchema,
  GovernanceCentersResponseSchema,
  GovernanceClassesResponseSchema,
  GovernanceAccountsResponseSchema,
  GovernanceMembershipsResponseSchema,
  GovernanceClassRevisionResponseSchema,
  GovernanceClassCreatedResponseSchema,
  GovernanceClassRenamedResponseSchema,
  GovernanceAccountCreatedResponseSchema,
  GovernanceAccountRenamedResponseSchema,
  GovernanceAccountStateChangedResponseSchema,
  GovernanceMembershipChangedResponseSchema,
  GovernanceSessionsRevokedResponseSchema,
  GovernanceClassExportedResponseSchema,
  GovernanceClassImportPreviewedResponseSchema,
  GovernanceClassImportConfirmedResponseSchema,
  GovernanceClassImportCancelledResponseSchema,
]);

/** Use before buffering a stream; bytes schemas below validate the complete raw body too. */
export function governanceRequestByteLimit(kind: GovernanceRequest["kind"]): number {
  return kind === "governance-class-export" || kind.startsWith("governance-class-import-")
    ? MAX_TEACHING_CONFIGURATION_BYTES
    : MAX_GOVERNANCE_REQUEST_BYTES;
}
export function governanceResponseByteLimit(kind: GovernanceResponse["kind"]): number {
  return kind === "governance-class-exported" || kind.startsWith("governance-class-import-")
    ? MAX_TEACHING_CONFIGURATION_BYTES
    : MAX_GOVERNANCE_RESPONSE_BYTES;
}

/** Raw UTF-8 JSON bodies, not reserialized projections. Transport still bounds streaming reads. */
export const GovernanceRequestBytesSchema = boundedGovernanceDocument(
  GovernanceRequestSchema,
  governanceRequestByteLimit,
);
export const GovernanceResponseBytesSchema = boundedGovernanceDocument(
  GovernanceResponseSchema,
  governanceResponseByteLimit,
);

export type Center = z.infer<typeof CenterSchema>;
export type GovernanceClass = z.infer<typeof GovernanceClassSchema>;
export type GovernanceAccount = z.infer<typeof GovernanceAccountSchema>;
export type Membership = z.infer<typeof MembershipSchema>;
export type GovernanceAccess = z.infer<typeof GovernanceAccessSchema>;
export type Revocation = z.infer<typeof RevocationSchema>;
export interface GovernancePage<T> {
  readonly items: readonly T[];
  readonly nextAfterId: string | null;
}
export type ClassExchange = z.infer<typeof ClassExchangeSchema>;
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;
export type GovernanceRequest = z.infer<typeof GovernanceRequestSchema>;
export type GovernanceResponse = z.infer<typeof GovernanceResponseSchema>;
export type GovernanceAccessQuery = z.infer<typeof GovernanceAccessQuerySchema>;
export type GovernanceCentersQuery = z.infer<typeof GovernanceCentersQuerySchema>;
export type GovernanceClassesQuery = z.infer<typeof GovernanceClassesQuerySchema>;
export type GovernanceAccountsQuery = z.infer<typeof GovernanceAccountsQuerySchema>;
export type GovernanceMembershipsQuery = z.infer<typeof GovernanceMembershipsQuerySchema>;
export type GovernanceClassRevisionQuery = z.infer<typeof GovernanceClassRevisionQuerySchema>;
export type GovernanceCreateClassRequest = z.infer<typeof GovernanceCreateClassRequestSchema>;
export type GovernanceRenameClassRequest = z.infer<typeof GovernanceRenameClassRequestSchema>;
export type GovernanceCreateAccountRequest = z.infer<typeof GovernanceCreateAccountRequestSchema>;
export type GovernanceRenameAccountRequest = z.infer<typeof GovernanceRenameAccountRequestSchema>;
export type GovernanceChangeAccountStateRequest = z.infer<
  typeof GovernanceChangeAccountStateRequestSchema
>;
export type GovernanceChangeMembershipRequest = z.infer<
  typeof GovernanceChangeMembershipRequestSchema
>;
export type GovernanceRevokeSessionsRequest = z.infer<typeof GovernanceRevokeSessionsRequestSchema>;
export type GovernanceExportClassRequest = z.infer<typeof GovernanceExportClassRequestSchema>;
export type GovernancePreviewClassImportRequest = z.infer<
  typeof GovernancePreviewClassImportRequestSchema
>;
export type GovernanceConfirmClassImportRequest = z.infer<
  typeof GovernanceConfirmClassImportRequestSchema
>;
export type GovernanceCancelClassImportRequest = z.infer<
  typeof GovernanceCancelClassImportRequestSchema
>;
export type GovernanceAccessResponse = z.infer<typeof GovernanceAccessResponseSchema>;
export type GovernanceCentersResponse = z.infer<typeof GovernanceCentersResponseSchema>;
export type GovernanceClassesResponse = z.infer<typeof GovernanceClassesResponseSchema>;
export type GovernanceAccountsResponse = z.infer<typeof GovernanceAccountsResponseSchema>;
export type GovernanceMembershipsResponse = z.infer<typeof GovernanceMembershipsResponseSchema>;
export type GovernanceClassRevisionResponse = z.infer<typeof GovernanceClassRevisionResponseSchema>;
export type GovernanceCreateClassResponse = z.infer<typeof GovernanceClassCreatedResponseSchema>;
export type GovernanceRenameClassResponse = z.infer<typeof GovernanceClassRenamedResponseSchema>;
export type GovernanceCreateAccountResponse = z.infer<
  typeof GovernanceAccountCreatedResponseSchema
>;
export type GovernanceRenameAccountResponse = z.infer<
  typeof GovernanceAccountRenamedResponseSchema
>;
export type GovernanceChangeAccountStateResponse = z.infer<
  typeof GovernanceAccountStateChangedResponseSchema
>;
export type GovernanceChangeMembershipResponse = z.infer<
  typeof GovernanceMembershipChangedResponseSchema
>;
export type GovernanceRevokeSessionsResponse = z.infer<
  typeof GovernanceSessionsRevokedResponseSchema
>;
export type GovernanceExportClassResponse = z.infer<typeof GovernanceClassExportedResponseSchema>;
export type GovernancePreviewClassImportResponse = z.infer<
  typeof GovernanceClassImportPreviewedResponseSchema
>;
export type GovernanceConfirmClassImportResponse = z.infer<
  typeof GovernanceClassImportConfirmedResponseSchema
>;
export type GovernanceCancelClassImportResponse = z.infer<
  typeof GovernanceClassImportCancelledResponseSchema
>;
