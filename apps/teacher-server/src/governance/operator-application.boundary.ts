import * as P from "@marea/protocol";
import { z } from "zod";
import type { OperatorContext } from "./authority.js";
import type { GovernanceOperatorApplication } from "./operator-contracts.js";
import type { GovernanceServiceDependencies } from "./service.boundary.js";
import { createPendingGovernanceAccount, governanceContext } from "./service.boundary.js";
import { GovernanceExchangeService } from "./exchange-service.js";
import { parseAdoptionMap } from "./adoption-validation.boundary.js";
import { TeachingConfigurationError } from "../teaching/configuration/dashboard-errors.js";

export type OperatorResources = Pick<
  GovernanceOperatorApplication,
  "validatePolicy" | "publishPolicy" | "listSkills" | "readSkill" | "validateSkill" | "saveSkill"
>;

const id = P.RevisionIdSchema;
const createCenter = z
  .object({ centerId: id, displayName: P.SafeDisplayNameSchema, expectedVersion: z.null() })
  .strict();
const renameCenter = createCenter.extend({ expectedVersion: id });
const associate = z.object({ centerId: id, userId: id, expectedVersion: z.null() }).strict();
const administrator = associate.extend({
  expectedVersion: id,
  capability: z.enum(["member", "administrator"]),
});
const credential = z
  .object({ userId: id, expectedVersion: id, password: P.CredentialPasswordSchema })
  .strict();

/** The non-serializable authority is supplied only by exclusive installation composition. */
export function operatorPayload(input: OperatorContext) {
  const { authority, now, requestId, ...payload } = input;
  authority.assertOwned();
  P.UtcTimestampSchema.parse(now);
  P.RequestIdSchema.parse(requestId);
  return payload;
}

export function createGovernanceOperatorApplication(
  dependencies: GovernanceServiceDependencies,
  resources: OperatorResources,
): GovernanceOperatorApplication {
  const repository = dependencies.repository;
  const exchange = new GovernanceExchangeService(dependencies);
  const authority = (input: OperatorContext) => ({
    kind: "operator" as const,
    installation: input.authority,
  });
  const context = (input: OperatorContext) => {
    input.authority.assertOwned();
    return {
      ...governanceContext(dependencies, authority(input), input.requestId),
      authority: input.authority,
    };
  };
  function privateMethod<Q, R>(
    schema: z.ZodType<Q>,
    work: (input: OperatorContext, request: Q) => R | Promise<R>,
  ) {
    return async (input: OperatorContext): Promise<R> => {
      const request = schema.parse(operatorPayload(input));
      return work(input, request);
    };
  }
  function ordinary<Q extends P.GovernanceRequest, R>(
    schema: z.ZodType<Q>,
    kind: Q["kind"],
    work: (input: OperatorContext, request: Q) => R | Promise<R>,
  ) {
    return async (input: OperatorContext): Promise<R> => {
      const payload = operatorPayload(input);
      if (Object.hasOwn(payload, "kind") || Object.hasOwn(payload, "protocolVersion"))
        throw new TeachingConfigurationError("invalid-request");
      const request = schema.parse(
        P.GovernanceRequestBytesSchema.parse(
          new TextEncoder().encode(
            JSON.stringify({
              ...payload,
              protocolVersion: "0.1",
              requestId: input.requestId,
              kind,
            }),
          ),
        ),
      );
      return work(input, request);
    };
  }
  const commitContext = (input: OperatorContext) =>
    governanceContext(dependencies, authority(input), input.requestId);
  return Object.freeze({
    createCenter: privateMethod(createCenter, (input, request) =>
      repository.commitCreateCenter({ ...request, context: context(input) }),
    ),
    renameCenter: privateMethod(renameCenter, (input, request) =>
      repository.commitRenameCenter({ ...request, context: context(input) }),
    ),
    associateAccount: privateMethod(associate, (input, request) =>
      repository.commitAssociateAccount({ ...request, context: context(input) }),
    ),
    setAdministrator: privateMethod(administrator, (input, request) =>
      repository.commitSetAdministrator({ ...request, context: context(input) }),
    ),
    provisionCredential: privateMethod(credential, async (input, request) => {
      const passwordHash = await dependencies.passwords.hash(request.password);
      return repository.commitProvisionCredential({
        userId: request.userId,
        expectedVersion: request.expectedVersion,
        passwordHash,
        context: context(input),
      });
    }),
    previewAdoption: privateMethod(
      z.object({ map: z.unknown().transform(parseAdoptionMap) }).strict(),
      (input, request) => repository.previewAdoption({ ...context(input), map: request.map }),
    ),
    confirmAdoption: privateMethod(
      z
        .object({ map: z.unknown().transform(parseAdoptionMap), digest: P.Sha256DigestSchema })
        .strict(),
      (input, request) =>
        repository.commitAdoption({
          context: context(input),
          map: request.map,
          expectedInventoryDigest: request.digest,
        }),
    ),
    createClass: ordinary(
      P.GovernanceCreateClassRequestSchema,
      "governance-class-create",
      (input, request) =>
        repository.commitCreateClass({ ...request, context: commitContext(input) }),
    ),
    renameClass: ordinary(
      P.GovernanceRenameClassRequestSchema,
      "governance-class-rename",
      (input, request) =>
        repository.commitRenameClass({ ...request, context: commitContext(input) }),
    ),
    createAccount: ordinary(
      P.GovernanceCreateAccountRequestSchema,
      "governance-account-create",
      (input, request) => createPendingGovernanceAccount(dependencies, authority(input), request),
    ),
    renameAccount: ordinary(
      P.GovernanceRenameAccountRequestSchema,
      "governance-account-rename",
      (input, request) =>
        repository.commitRenameAccount({ ...request, context: commitContext(input) }),
    ),
    changeAccountState: ordinary(
      P.GovernanceChangeAccountStateRequestSchema,
      "governance-account-state-change",
      (input, request) =>
        repository.commitChangeAccountState({ ...request, context: commitContext(input) }),
    ),
    changeMembership: ordinary(
      P.GovernanceChangeMembershipRequestSchema,
      "governance-membership-change",
      (input, request) =>
        repository.commitChangeMembership({ ...request, context: commitContext(input) }),
    ),
    revokeSessions: ordinary(
      P.GovernanceRevokeSessionsRequestSchema,
      "governance-sessions-revoke",
      (input, request) =>
        repository.commitRevokeSessions({ ...request, context: commitContext(input) }),
    ),
    exportClass: ordinary(
      P.GovernanceExportClassRequestSchema,
      "governance-class-export",
      (input, request) => exchange.exportClass(authority(input), request),
    ),
    previewClassImport: ordinary(
      P.GovernancePreviewClassImportRequestSchema,
      "governance-class-import-preview",
      (input, request) => exchange.preview(authority(input), request),
    ),
    confirmClassImport: ordinary(
      P.GovernanceConfirmClassImportRequestSchema,
      "governance-class-import-confirm",
      (input, request) => exchange.confirm(authority(input), request),
    ),
    cancelClassImport: ordinary(
      P.GovernanceCancelClassImportRequestSchema,
      "governance-class-import-cancel",
      (input, request) => exchange.cancel(authority(input), request),
    ),
    ...resources,
  });
}
