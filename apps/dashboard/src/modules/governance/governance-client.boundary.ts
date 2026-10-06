import { browserRandomUUID } from "../../browser-random-uuid.js";
import {
  CURRENT_PROTOCOL_VERSION,
  GovernanceAccessQuerySchema,
  GovernanceAccessResponseSchema,
  GovernanceAccountsQuerySchema,
  GovernanceAccountsResponseSchema,
  GovernanceAccountCreatedResponseSchema,
  GovernanceCancelClassImportRequestSchema,
  GovernanceClassImportCancelledResponseSchema,
  GovernanceCentersQuerySchema,
  GovernanceCentersResponseSchema,
  GovernanceChangeAccountStateRequestSchema,
  GovernanceAccountStateChangedResponseSchema,
  GovernanceChangeMembershipRequestSchema,
  GovernanceClassCreatedResponseSchema,
  GovernanceClassExportedResponseSchema,
  GovernanceClassImportConfirmedResponseSchema,
  GovernanceClassImportPreviewedResponseSchema,
  GovernanceClassRevisionQuerySchema,
  GovernanceClassRevisionResponseSchema,
  GovernanceClassRenamedResponseSchema,
  GovernanceClassesQuerySchema,
  GovernanceClassesResponseSchema,
  GovernanceConfirmClassImportRequestSchema,
  GovernanceCreateAccountRequestSchema,
  GovernanceCreateClassRequestSchema,
  GovernanceExportClassRequestSchema,
  GovernanceMembershipChangedResponseSchema,
  GovernanceMembershipsQuerySchema,
  GovernanceMembershipsResponseSchema,
  GovernancePreviewClassImportRequestSchema,
  GovernanceRenameAccountRequestSchema,
  GovernanceAccountRenamedResponseSchema,
  GovernanceRenameClassRequestSchema,
  GovernanceRevokeSessionsRequestSchema,
  GovernanceSessionsRevokedResponseSchema,
  MAX_GOVERNANCE_REQUEST_BYTES,
  MAX_GOVERNANCE_RESPONSE_BYTES,
  MAX_TEACHING_CONFIGURATION_BYTES,
  RequestIdSchema,
} from "@marea/protocol";
import type * as z from "zod";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import {
  type GovernanceClient,
  type GovernanceAccountsInput,
  type GovernanceCentersInput,
  type GovernanceChangeAccountStateInput,
  type GovernanceChangeMembershipInput,
  type GovernanceCancelClassImportInput,
  type GovernanceClassesInput,
  type GovernanceClassRevisionInput,
  type GovernanceConfirmClassImportInput,
  type GovernanceCreateAccountInput,
  type GovernanceCreateClassInput,
  type GovernanceExportClassInput,
  type GovernanceMembershipsInput,
  type GovernancePreviewClassImportInput,
  type GovernanceRenameAccountInput,
  type GovernanceRenameClassInput,
  type GovernanceRevokeSessionsInput,
} from "./governance-contracts.js";
import {
  readGovernanceResponse,
  serializeGovernanceRequest,
} from "./governance-response.boundary.js";

import {
  governanceFailure,
  pageIsValid,
  statusProblem,
  transportProblem,
  type RequestWithEnvelope,
  type ResponseWithEnvelope,
} from "./governance-client.helpers.js";

const GOVERNANCE_PATH = "/api/v1/dashboard/governance";
const ENVELOPE_FIELDS = ["protocolVersion", "requestId", "kind"] as const;

const browserRequestId = (): string => `request:${browserRandomUUID()}`;

export function createGovernanceClient(
  fetchRequest: DashboardFetch,
  createRequestId: () => string = browserRequestId,
): GovernanceClient {
  function makeRequest<T extends RequestWithEnvelope>(
    schema: z.ZodType<T>,
    kind: T["kind"],
    payload: object | null,
  ): T {
    if (payload === null) {
      throw governanceFailure("invalid", "The governance request is invalid.");
    }
    for (const field of ENVELOPE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) {
        throw governanceFailure("invalid", "The governance request contains reserved fields.");
      }
    }
    let requestId: string;
    try {
      requestId = createRequestId();
    } catch {
      throw governanceFailure("invalid", "The governance request ID could not be generated.");
    }
    const idResult = RequestIdSchema.safeParse(requestId);
    if (!idResult.success) {
      throw governanceFailure("invalid", "The governance request ID is invalid.");
    }
    const parsed = schema.safeParse({
      ...payload,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: idResult.data,
      kind,
    });
    if (!parsed.success) {
      throw governanceFailure("invalid", "The governance request is invalid.");
    }
    return parsed.data;
  }

  async function post<TRequest extends RequestWithEnvelope, TResponse extends ResponseWithEnvelope>(
    path: string,
    schema: z.ZodType<TRequest>,
    kind: TRequest["kind"],
    payload: object,
    responseSchema: z.ZodType<TResponse>,
    signal: AbortSignal,
    mutation: boolean,
    requestLimit: number,
    responseLimit: number,
    correlates: (response: TResponse, request: TRequest) => boolean = () => true,
  ): Promise<TResponse> {
    const request = makeRequest(schema, kind, payload);
    const serialized = serializeGovernanceRequest(request, requestLimit);

    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetchRequest(`${GOVERNANCE_PATH}/${path}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: serialized,
      });
    } catch {
      throw governanceFailure(
        transportProblem(mutation, signal),
        "The governance request could not be sent.",
      );
    }

    if (signal.aborted) {
      throw governanceFailure("uncertain", "The governance request was aborted after dispatch.");
    }
    if (!response.ok) {
      // Release the unread rejection body so the browser does not keep the request open.
      await response.body?.cancel().catch(() => undefined);
      throw governanceFailure(
        statusProblem(response.status, mutation),
        "The governance request was rejected.",
      );
    }

    let text: string;
    try {
      text = await readGovernanceResponse(response, responseLimit, signal);
      const raw: unknown = JSON.parse(text);
      const parsed = responseSchema.parse(raw);
      if (parsed.requestId !== request.requestId) throw new Error();
      if (!correlates(parsed, request)) throw new Error();
      return parsed;
    } catch {
      throw governanceFailure(
        transportProblem(mutation, signal),
        "The governance response is invalid.",
      );
    }
  }

  const operation =
    (isMutation: boolean) =>
    async <TRequest extends RequestWithEnvelope, TResponse extends ResponseWithEnvelope>(
      path: string,
      schema: z.ZodType<TRequest>,
      kind: TRequest["kind"],
      payload: object,
      responseSchema: z.ZodType<TResponse>,
      signal: AbortSignal,
      requestLimit = MAX_GOVERNANCE_REQUEST_BYTES,
      responseLimit = MAX_GOVERNANCE_RESPONSE_BYTES,
      correlates?: (response: TResponse, request: TRequest) => boolean,
    ): Promise<TResponse> =>
      post(
        path,
        schema,
        kind,
        payload,
        responseSchema,
        signal,
        isMutation,
        requestLimit,
        responseLimit,
        correlates,
      );

  const query = operation(false);
  const mutation = operation(true);

  return Object.freeze<GovernanceClient>({
    access(signal: AbortSignal) {
      return query(
        "access",
        GovernanceAccessQuerySchema,
        "governance-access-query",
        {},
        GovernanceAccessResponseSchema,
        signal,
      );
    },

    centers(input: GovernanceCentersInput, signal: AbortSignal) {
      return query(
        "centers",
        GovernanceCentersQuerySchema,
        "governance-centers-query",
        input,
        GovernanceCentersResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) => pageIsValid(response, request.afterId, (item) => item.centerId),
      );
    },

    classes(input: GovernanceClassesInput, signal: AbortSignal) {
      return query(
        "classes",
        GovernanceClassesQuerySchema,
        "governance-classes-query",
        input,
        GovernanceClassesResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          pageIsValid(
            response,
            request.afterId,
            (item) => item.classId,
            (item) => item.centerId === request.centerId,
          ),
      );
    },

    accounts(input: GovernanceAccountsInput, signal: AbortSignal) {
      return query(
        "accounts",
        GovernanceAccountsQuerySchema,
        "governance-accounts-query",
        input,
        GovernanceAccountsResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          pageIsValid(
            response,
            request.afterId,
            (item) => item.userId,
            (item) => item.centerId === request.centerId,
          ),
      );
    },

    memberships(input: GovernanceMembershipsInput, signal: AbortSignal) {
      return query(
        "memberships",
        GovernanceMembershipsQuerySchema,
        "governance-memberships-query",
        input,
        GovernanceMembershipsResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          pageIsValid(
            response,
            request.afterId,
            (item) => item.userId,
            (item) => item.centerId === request.centerId && item.classId === request.classId,
          ),
      );
    },

    classRevision(input: GovernanceClassRevisionInput, signal: AbortSignal) {
      return query(
        "class/revision",
        GovernanceClassRevisionQuerySchema,
        "governance-class-revision-query",
        input,
        GovernanceClassRevisionResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          response.centerId === request.centerId && response.classId === request.classId,
      );
    },

    createClass(input: GovernanceCreateClassInput, signal: AbortSignal) {
      return mutation(
        "class/create",
        GovernanceCreateClassRequestSchema,
        "governance-class-create",
        input,
        GovernanceClassCreatedResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          response.classroom.centerId === request.centerId &&
          response.classroom.classId === request.classId,
      );
    },
    renameClass(input: GovernanceRenameClassInput, signal: AbortSignal) {
      return mutation(
        "class/rename",
        GovernanceRenameClassRequestSchema,
        "governance-class-rename",
        input,
        GovernanceClassRenamedResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          response.classroom.centerId === request.centerId &&
          response.classroom.classId === request.classId,
      );
    },
    createAccount(input: GovernanceCreateAccountInput, signal: AbortSignal) {
      return mutation(
        "account/create",
        GovernanceCreateAccountRequestSchema,
        "governance-account-create",
        input,
        GovernanceAccountCreatedResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          response.account.centerId === request.centerId &&
          response.account.userId === request.userId,
      );
    },
    renameAccount(input: GovernanceRenameAccountInput, signal: AbortSignal) {
      return mutation(
        "account/rename",
        GovernanceRenameAccountRequestSchema,
        "governance-account-rename",
        input,
        GovernanceAccountRenamedResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          response.account.centerId === request.centerId &&
          response.account.userId === request.userId,
      );
    },
    changeAccountState(input: GovernanceChangeAccountStateInput, signal: AbortSignal) {
      return mutation(
        "account/state",
        GovernanceChangeAccountStateRequestSchema,
        "governance-account-state-change",
        input,
        GovernanceAccountStateChangedResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          response.account.centerId === request.centerId &&
          response.account.userId === request.userId,
      );
    },
    changeMembership(input: GovernanceChangeMembershipInput, signal: AbortSignal) {
      return mutation(
        "membership/change",
        GovernanceChangeMembershipRequestSchema,
        "governance-membership-change",
        input,
        GovernanceMembershipChangedResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) =>
          response.membership.centerId === request.centerId &&
          response.membership.classId === request.classId &&
          response.membership.userId === request.userId,
      );
    },
    revokeSessions(input: GovernanceRevokeSessionsInput, signal: AbortSignal) {
      return mutation(
        "sessions/revoke",
        GovernanceRevokeSessionsRequestSchema,
        "governance-sessions-revoke",
        input,
        GovernanceSessionsRevokedResponseSchema,
        signal,
        MAX_GOVERNANCE_REQUEST_BYTES,
        MAX_GOVERNANCE_RESPONSE_BYTES,
        (response, request) => response.revocation.userId === request.userId,
      );
    },
    exportClass(input: GovernanceExportClassInput, signal: AbortSignal) {
      return mutation(
        "class/export",
        GovernanceExportClassRequestSchema,
        "governance-class-export",
        input,
        GovernanceClassExportedResponseSchema,
        signal,
        MAX_TEACHING_CONFIGURATION_BYTES,
        MAX_TEACHING_CONFIGURATION_BYTES,
      );
    },
    previewClassImport(input: GovernancePreviewClassImportInput, signal: AbortSignal) {
      return mutation(
        "class/import/preview",
        GovernancePreviewClassImportRequestSchema,
        "governance-class-import-preview",
        input,
        GovernanceClassImportPreviewedResponseSchema,
        signal,
        MAX_TEACHING_CONFIGURATION_BYTES,
        MAX_TEACHING_CONFIGURATION_BYTES,
        (response, request) =>
          response.preview.centerId === request.centerId &&
          response.preview.classId === request.classId &&
          response.preview.expectedTeachingVersion === request.expectedTeachingVersion,
      );
    },
    confirmClassImport(input: GovernanceConfirmClassImportInput, signal: AbortSignal) {
      return mutation(
        "class/import/confirm",
        GovernanceConfirmClassImportRequestSchema,
        "governance-class-import-confirm",
        input,
        GovernanceClassImportConfirmedResponseSchema,
        signal,
        MAX_TEACHING_CONFIGURATION_BYTES,
        MAX_TEACHING_CONFIGURATION_BYTES,
        (response, request) => response.classId === request.classId,
      );
    },
    cancelClassImport(input: GovernanceCancelClassImportInput, signal: AbortSignal) {
      return mutation(
        "class/import/cancel",
        GovernanceCancelClassImportRequestSchema,
        "governance-class-import-cancel",
        input,
        GovernanceClassImportCancelledResponseSchema,
        signal,
        MAX_TEACHING_CONFIGURATION_BYTES,
        MAX_TEACHING_CONFIGURATION_BYTES,
        (response, request) => response.previewId === request.previewId,
      );
    },
  });
}
