import * as P from "@marea/protocol";
import type { z } from "zod";
import type { GovernanceService, GovernanceRepository } from "./contracts.js";
import type {
  GovernanceAuthority,
  GovernanceCommitContext,
  GovernanceIdGenerator,
  GovernanceSession,
} from "./authority.js";
import type { Clock, PasswordHasher, SecretIssuer } from "../identity/contracts.js";
import { TeachingConfigurationError } from "../teaching/configuration/dashboard-errors.js";
import {
  GovernanceExchangeService,
  type GovernanceExchangeDependencies,
} from "./exchange-service.js";

export interface GovernanceServiceDependencies extends GovernanceExchangeDependencies {
  readonly passwords: PasswordHasher;
  readonly secrets: SecretIssuer;
}

export function governanceContext(
  dependencies: { clock: Clock; ids: GovernanceIdGenerator },
  authority: GovernanceAuthority,
  requestId: P.RequestId,
): GovernanceCommitContext {
  return {
    authority,
    requestId,
    now: P.UtcTimestampSchema.parse(dependencies.clock.now()),
    generatedVersion: dependencies.ids.createId("revision"),
  };
}

export async function createPendingGovernanceAccount(
  dependencies: {
    repository: GovernanceRepository;
    clock: Clock;
    ids: GovernanceIdGenerator;
    passwords: PasswordHasher;
    secrets: SecretIssuer;
  },
  authority: GovernanceAuthority,
  request: P.GovernanceCreateAccountRequest,
) {
  dependencies.repository.listAccounts(
    governanceContext(dependencies, authority, request.requestId),
    request.centerId,
    null,
  );
  const passwordHash = await dependencies.passwords.hash(dependencies.secrets.issue());
  return dependencies.repository.commitCreateAccount({
    ...request,
    passwordHash,
    context: governanceContext(dependencies, authority, request.requestId),
  });
}

function handle<Q extends P.GovernanceRequest, R extends P.GovernanceResponse>(
  requestSchema: z.ZodType<Q>,
  responseSchema: z.ZodType<R>,
  work: (authority: GovernanceAuthority, request: Q) => object | Promise<object>,
) {
  return async (session: GovernanceSession, request: Q): Promise<R> => {
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    const parsed = requestSchema.safeParse(P.GovernanceRequestBytesSchema.parse(bytes));
    if (!parsed.success) throw new TeachingConfigurationError("invalid-request");
    const result = await work({ kind: "administrator", session }, parsed.data);
    const response = {
      protocolVersion: parsed.data.protocolVersion,
      requestId: parsed.data.requestId,
      ...result,
    };
    return responseSchema.parse(
      P.GovernanceResponseBytesSchema.parse(new TextEncoder().encode(JSON.stringify(response))),
    );
  };
}

/** No transport or operator actor selector is exposed by this service. */
export function createGovernanceService(
  dependencies: GovernanceServiceDependencies,
): GovernanceService {
  const repository = dependencies.repository;
  const exchange = new GovernanceExchangeService(dependencies);
  const context = (authority: GovernanceAuthority, requestId: P.RequestId) =>
    governanceContext(dependencies, authority, requestId);
  return Object.freeze({
    access: handle(
      P.GovernanceAccessQuerySchema,
      P.GovernanceAccessResponseSchema,
      (authority, request) => ({
        kind: "governance-access-response",
        access: repository.requireAccess(context(authority, request.requestId)),
      }),
    ),
    centers: handle(
      P.GovernanceCentersQuerySchema,
      P.GovernanceCentersResponseSchema,
      (authority, request) => ({
        kind: "governance-centers-response",
        ...repository.listCenters(context(authority, request.requestId), request.afterId),
      }),
    ),
    classes: handle(
      P.GovernanceClassesQuerySchema,
      P.GovernanceClassesResponseSchema,
      (authority, request) => ({
        kind: "governance-classes-response",
        ...repository.listClasses(
          context(authority, request.requestId),
          request.centerId,
          request.afterId,
        ),
      }),
    ),
    accounts: handle(
      P.GovernanceAccountsQuerySchema,
      P.GovernanceAccountsResponseSchema,
      (authority, request) => ({
        kind: "governance-accounts-response",
        ...repository.listAccounts(
          context(authority, request.requestId),
          request.centerId,
          request.afterId,
        ),
      }),
    ),
    memberships: handle(
      P.GovernanceMembershipsQuerySchema,
      P.GovernanceMembershipsResponseSchema,
      (authority, request) => ({
        kind: "governance-memberships-response",
        ...repository.listMemberships(
          { ...request, context: context(authority, request.requestId) },
          request.afterId,
        ),
      }),
    ),
    classRevision: handle(
      P.GovernanceClassRevisionQuerySchema,
      P.GovernanceClassRevisionResponseSchema,
      (authority, request) => {
        const current = repository.loadClassForExchange({
          context: context(authority, request.requestId),
          centerId: request.centerId,
          classId: request.classId,
        });
        return {
          kind: "governance-class-revision-response",
          centerId: request.centerId,
          classId: request.classId,
          teachingVersion: current.teachingVersion,
        };
      },
    ),
    createClass: handle(
      P.GovernanceCreateClassRequestSchema,
      P.GovernanceClassCreatedResponseSchema,
      (authority, request) => ({
        kind: "governance-class-created",
        classroom: repository.commitCreateClass({
          ...request,
          context: context(authority, request.requestId),
        }),
      }),
    ),
    renameClass: handle(
      P.GovernanceRenameClassRequestSchema,
      P.GovernanceClassRenamedResponseSchema,
      (authority, request) => ({
        kind: "governance-class-renamed",
        classroom: repository.commitRenameClass({
          ...request,
          context: context(authority, request.requestId),
        }),
      }),
    ),
    createAccount: handle(
      P.GovernanceCreateAccountRequestSchema,
      P.GovernanceAccountCreatedResponseSchema,
      async (authority, request) => ({
        kind: "governance-account-created",
        account: await createPendingGovernanceAccount(dependencies, authority, request),
      }),
    ),
    renameAccount: handle(
      P.GovernanceRenameAccountRequestSchema,
      P.GovernanceAccountRenamedResponseSchema,
      (authority, request) => ({
        kind: "governance-account-renamed",
        account: repository.commitRenameAccount({
          ...request,
          context: context(authority, request.requestId),
        }),
      }),
    ),
    changeAccountState: handle(
      P.GovernanceChangeAccountStateRequestSchema,
      P.GovernanceAccountStateChangedResponseSchema,
      (authority, request) => ({
        kind: "governance-account-state-changed",
        account: repository.commitChangeAccountState({
          ...request,
          context: context(authority, request.requestId),
        }),
      }),
    ),
    changeMembership: handle(
      P.GovernanceChangeMembershipRequestSchema,
      P.GovernanceMembershipChangedResponseSchema,
      (authority, request) => ({
        kind: "governance-membership-changed",
        membership: repository.commitChangeMembership({
          ...request,
          context: context(authority, request.requestId),
        }),
      }),
    ),
    revokeSessions: handle(
      P.GovernanceRevokeSessionsRequestSchema,
      P.GovernanceSessionsRevokedResponseSchema,
      (authority, request) => ({
        kind: "governance-sessions-revoked",
        revocation: repository.commitRevokeSessions({
          ...request,
          context: context(authority, request.requestId),
        }),
      }),
    ),
    exportClass: handle(
      P.GovernanceExportClassRequestSchema,
      P.GovernanceClassExportedResponseSchema,
      (authority, request) => ({
        kind: "governance-class-exported",
        package: exchange.exportClass(authority, request),
      }),
    ),
    previewClassImport: handle(
      P.GovernancePreviewClassImportRequestSchema,
      P.GovernanceClassImportPreviewedResponseSchema,
      async (authority, request) => ({
        kind: "governance-class-import-previewed",
        preview: await exchange.preview(authority, request),
      }),
    ),
    confirmClassImport: handle(
      P.GovernanceConfirmClassImportRequestSchema,
      P.GovernanceClassImportConfirmedResponseSchema,
      async (authority, request) => ({
        kind: "governance-class-import-confirmed",
        ...(await exchange.confirm(authority, request)),
      }),
    ),
    cancelClassImport: handle(
      P.GovernanceCancelClassImportRequestSchema,
      P.GovernanceClassImportCancelledResponseSchema,
      (authority, request) => ({
        kind: "governance-class-import-cancelled",
        ...exchange.cancel(authority, request),
      }),
    ),
  });
}
