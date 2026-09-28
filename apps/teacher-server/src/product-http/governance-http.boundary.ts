import { Hono } from "hono";
import {
  GovernanceRequestSchema,
  governanceRequestByteLimit,
  governanceResponseByteLimit,
  type GovernanceRequest,
  type GovernanceResponse,
  type RequestId,
} from "@marea/protocol";
import { isJson, readRequest, RequestPolicy } from "@marea/transport-server";
import type { GovernanceSessionResolver } from "../governance/authority.js";
import type { GovernanceService } from "../governance/contracts.js";
import type { Clock, SecretDigest } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import { GovernanceResourceError } from "../governance/errors.js";
import { SkillSnapshotError } from "../teaching/skills/materialize-skills.js";
import {
  TeachingConfigurationError,
  teachingConfigurationError,
} from "../teaching/configuration/dashboard-errors.js";
import { jsonResponse, protocolError } from "./response.js";

const PREFIX = "/api/v1/dashboard/governance";
type JsonParseResult = { readonly value: unknown } | null;

function parseJson(body: string): JsonParseResult {
  try {
    return { value: JSON.parse(body) };
  } catch {
    return null;
  }
}

interface GovernanceRoute {
  readonly suffix: string;
  readonly requestKind: GovernanceRequest["kind"];
  readonly responseKind: GovernanceResponse["kind"];
  readonly requestBytes: number;
  readonly responseBytes: number;
}

const route = (
  requestKind: GovernanceRequest["kind"],
  suffix: string,
  responseKind: GovernanceResponse["kind"],
): GovernanceRoute => ({
  suffix,
  requestKind,
  responseKind,
  requestBytes: governanceRequestByteLimit(requestKind),
  responseBytes: governanceResponseByteLimit(responseKind),
});

const ROUTES: readonly GovernanceRoute[] = [
  route("governance-access-query", "access", "governance-access-response"),
  route("governance-centers-query", "centers", "governance-centers-response"),
  route("governance-classes-query", "classes", "governance-classes-response"),
  route("governance-accounts-query", "accounts", "governance-accounts-response"),
  route("governance-memberships-query", "memberships", "governance-memberships-response"),
  route("governance-class-revision-query", "class/revision", "governance-class-revision-response"),
  route("governance-class-create", "class/create", "governance-class-created"),
  route("governance-class-rename", "class/rename", "governance-class-renamed"),
  route("governance-account-create", "account/create", "governance-account-created"),
  route("governance-account-rename", "account/rename", "governance-account-renamed"),
  route("governance-account-state-change", "account/state", "governance-account-state-changed"),
  route("governance-membership-change", "membership/change", "governance-membership-changed"),
  route("governance-sessions-revoke", "sessions/revoke", "governance-sessions-revoked"),
  route("governance-class-export", "class/export", "governance-class-exported"),
  route(
    "governance-class-import-preview",
    "class/import/preview",
    "governance-class-import-previewed",
  ),
  route(
    "governance-class-import-confirm",
    "class/import/confirm",
    "governance-class-import-confirmed",
  ),
  route(
    "governance-class-import-cancel",
    "class/import/cancel",
    "governance-class-import-cancelled",
  ),
];

function cookie(request: Request, name: string): string {
  const header = request.headers.get("cookie");
  if (header === null || header.length > 8_192) throw new TeacherDomainError("auth.invalid");
  const prefix = `${name}=`;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  if (values.length !== 1) throw new TeacherDomainError("auth.invalid");
  const match = String(values[0]);
  const token = match.slice(prefix.length);
  if (token.length === 0 || /\s/u.test(token)) throw new TeacherDomainError("auth.invalid");
  return token;
}

async function requestBody(
  request: Request,
  maxBytes: number,
): Promise<GovernanceRequest | Response> {
  if (!isJson(request.headers.get("content-type") ?? undefined)) {
    return protocolError(415, "request.invalid", false);
  }
  const body = await readRequest(request, maxBytes);
  if (body instanceof Response) return protocolError(body.status, "request.invalid", false);
  const parseResult = parseJson(body);
  if (parseResult === null) return protocolError(400, "request.invalid", false);
  const parsed = GovernanceRequestSchema.safeParse(parseResult.value);
  return parsed.success ? parsed.data : protocolError(400, "request.invalid", false);
}

function boundedResponse(value: object, requestId: RequestId, maxBytes: number): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    return protocolError(413, "request.invalid", false, requestId);
  }
  return jsonResponse(value);
}

function failure(error: unknown, requestId: RequestId): Response {
  if (error instanceof GovernanceResourceError) {
    return protocolError(413, "request.invalid", false, requestId);
  }
  if (error instanceof TeacherDomainError || error instanceof TeachingConfigurationError) {
    return teachingConfigurationError(error, requestId);
  }
  // Import materialization reports a missing, changed or duplicate selected skill.
  if (error instanceof SkillSnapshotError) {
    return protocolError(422, "request.invalid", false, requestId);
  }
  return protocolError(500, "server.error", true, requestId);
}

async function invoke(
  service: GovernanceService,
  session: Parameters<GovernanceService["access"]>[0],
  request: GovernanceRequest,
): Promise<object> {
  switch (request.kind) {
    case "governance-access-query":
      return service.access(session, request);
    case "governance-centers-query":
      return service.centers(session, request);
    case "governance-classes-query":
      return service.classes(session, request);
    case "governance-accounts-query":
      return service.accounts(session, request);
    case "governance-memberships-query":
      return service.memberships(session, request);
    case "governance-class-revision-query":
      return service.classRevision(session, request);
    case "governance-class-create":
      return service.createClass(session, request);
    case "governance-class-rename":
      return service.renameClass(session, request);
    case "governance-account-create":
      return service.createAccount(session, request);
    case "governance-account-rename":
      return service.renameAccount(session, request);
    case "governance-account-state-change":
      return service.changeAccountState(session, request);
    case "governance-membership-change":
      return service.changeMembership(session, request);
    case "governance-sessions-revoke":
      return service.revokeSessions(session, request);
    case "governance-class-export":
      return service.exportClass(session, request);
    case "governance-class-import-preview":
      return service.previewClassImport(session, request);
    case "governance-class-import-confirm":
      return service.confirmClassImport(session, request);
    case "governance-class-import-cancel":
      return service.cancelClassImport(session, request);
  }
}

export function registerGovernanceRoutes(input: {
  readonly app: Hono;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly cookieName: string;
  readonly service: GovernanceService;
  readonly sessions: GovernanceSessionResolver;
  readonly digest: SecretDigest;
  readonly clock: Clock;
}): void {
  const policy = new RequestPolicy({
    allowedHosts: input.allowedHosts,
    allowedOrigins: input.allowedOrigins,
  });
  for (const route of ROUTES) {
    input.app.post(`${PREFIX}/${route.suffix}`, async (context) => {
      if (!policy.evaluate(context.req.raw).allowed) {
        return protocolError(403, "request.invalid", false);
      }
      const request = await requestBody(context.req.raw, route.requestBytes);
      if (request instanceof Response) return request;
      const value = request;
      if (value.kind !== route.requestKind)
        return protocolError(400, "request.invalid", false, value.requestId);
      try {
        const token = cookie(context.req.raw, input.cookieName);
        const session = input.sessions.resolve(input.digest.digest(token), input.clock.now());
        if (session === undefined)
          return protocolError(401, "auth.invalid", false, value.requestId);
        return boundedResponse(
          await invoke(input.service, session, value),
          value.requestId,
          route.responseBytes,
        );
      } catch (error: unknown) {
        return failure(error, value.requestId);
      }
    });
  }
}
