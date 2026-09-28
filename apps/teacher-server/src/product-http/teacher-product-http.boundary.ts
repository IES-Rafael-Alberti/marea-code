import { registerDashboardModuleRoutes } from "./dashboard-module-routes.js";
import { registerLiveRoute, teacherCookieIdentity } from "./live-http.boundary.js";
import { parseCookie, dashboardCookie, validateCookieName } from "./dashboard-cookie.js";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  ActiveRunDashboardQuerySchema,
  EvaluationQuerySchema,
  GenerateEvaluationRequestSchema,
  ApproveEvaluationRequestSchema,
  AcknowledgeNoticeRequestSchema,
  PendingNoticesRequestSchema,
  PublishTeacherNoticeRequestSchema,
  TeacherNoticeQuerySchema,
  AppendRunEventsRequestSchema,
  MAX_RUN_EVENTS_REQUEST_BYTES,
  CapabilitiesRequestSchema,
  CapabilitiesResponseSchema,
  ClassBootstrapRequestSchema,
  CloseRunRequestSchema,
  CredentialLoginRequestSchema,
  CURRENT_PROTOCOL_VERSION,
  EnrollStudentRequestSchema,
  ModelGatewayRequestSchema,
  OpenRunRequestSchema,
  RenewRunLeaseRequestSchema,
  RunSkillRequestSchema,
  RunHistoryQuerySchema,
  SessionHistoryQuerySchema,
  SoftwareVersionSchema,
  type RequestId,
} from "@marea/protocol";
import { isJson, parseBearerCredential, readRequest, RequestPolicy } from "@marea/transport-server";
import * as z from "zod";
import { TeacherDomainError } from "../identity/errors.js";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { ModelGatewayService } from "../model-gateway/model-gateway-service.js";
import type { TeacherProductHttpApplication, TeacherProductHttpOptions } from "./contracts.js";
import { modelStreamResponse } from "./model-stream.js";
import { jsonResponse, protocolError } from "./response.js";
import { registerTeachingRoutes } from "./teaching-http.boundary.js";
import { registerSkillAuthoringRoutes } from "./skill-authoring-http.boundary.js";
import { registerGovernanceRoutes } from "./governance-http.boundary.js";
import { registerDashboardSessionRoutes } from "./dashboard-session-http.boundary.js";
const JSON_REQUEST_LIMIT = 64 * 1_024;
const MODEL_REQUEST_LIMIT = 2 * 1_024 * 1_024;
const DEFAULT_COOKIE_NAME = "marea_teacher_session";
const DASHBOARD_QUERY_KEYS = new Set(["cursor", "kind", "limit", "protocolVersion", "requestId"]);
const CAPABILITIES = [
  "marea.auth.student",
  "marea.class.bootstrap",
  "marea.runs.events",
  "marea.runs.lifecycle",
  "marea.runs.exact-resume",
  "marea.runs.authenticated-close",
  "marea.runs.lease-renewal",
  "marea.runs.skills",
  "marea.runs.history",
  "marea.teacher.notices",
] as const;
interface Parsed<T> {
  readonly ok: true;
  readonly value: T;
}
type ParseResult<T> = Parsed<T> | { readonly ok: false; readonly response: Response };
function policyMiddleware(
  policy: RequestPolicy,
  allowSearch: boolean,
  requireOrigin = false,
): MiddlewareHandler {
  return async (context, next) => {
    if (!policy.evaluate(context.req.raw, { allowSearch, requireOrigin }).allowed) {
      return protocolError(403, "request.invalid", false);
    }
    await next();
    return context.res;
  };
}
async function parseJsonRequest<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = JSON_REQUEST_LIMIT,
): Promise<ParseResult<T>> {
  if (!isJson(request.headers.get("content-type") ?? undefined)) {
    return { ok: false, response: protocolError(415, "request.invalid", false) };
  }
  const text = await readRequest(request, maxBytes);
  if (text instanceof Response) {
    return { ok: false, response: protocolError(text.status, "request.invalid", false) };
  }
  let input: unknown;
  // Stryker disable BlockStatement: Emptying this catch still delegates undefined to the same schema error.
  try {
    input = JSON.parse(text);
  } catch {
    return { ok: false, response: protocolError(400, "request.invalid", false) };
  }
  // Stryker restore BlockStatement
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, response: protocolError(400, "request.invalid", false) };
}
function bearer(request: Request): string {
  const token = parseBearerCredential(request.headers.get("authorization") ?? undefined);
  if (token === undefined) throw new TeacherDomainError("auth.invalid");
  return token;
}
function domainError(error: unknown, requestId: RequestId): Response {
  if (!(error instanceof TeacherDomainError)) {
    return protocolError(500, "server.error", true, requestId);
  }
  if (error.code === "auth.busy") {
    return protocolError(503, "server.error", true, requestId);
  }
  if (error.code === "auth.invalid") {
    return protocolError(401, "auth.invalid", false, requestId);
  }
  if (error.code === "run.unavailable") {
    return protocolError(409, "run.unavailable", false, requestId);
  }
  return protocolError(
    error.code === "dashboard.forbidden" ? 403 : 409,
    "request.invalid",
    false,
    requestId,
  );
}
async function safeOperation(
  requestId: RequestId,
  operation: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await operation();
  } catch (error: unknown) {
    return domainError(error, requestId);
  }
}
function parseDashboardQuery(url: URL): ParseResult<z.infer<typeof ActiveRunDashboardQuerySchema>> {
  for (const key of url.searchParams.keys()) {
    if (!DASHBOARD_QUERY_KEYS.has(key) || url.searchParams.getAll(key).length !== 1) {
      return { ok: false, response: protocolError(400, "request.invalid", false) };
    }
  }
  const cursor = url.searchParams.get("cursor");
  const parsed = ActiveRunDashboardQuerySchema.safeParse({
    ...(cursor === null ? {} : { cursor }),
    kind: url.searchParams.get("kind"),
    limit: Number(url.searchParams.get("limit")),
    protocolVersion: url.searchParams.get("protocolVersion"),
    requestId: url.searchParams.get("requestId"),
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, response: protocolError(400, "request.invalid", false) };
}

async function authenticatedJson<T extends { readonly requestId: RequestId }>(
  request: Request,
  schema: z.ZodType<T>,
  authenticate: (request: Request) => AuthenticatedIdentity,
  operation: (identity: AuthenticatedIdentity, query: T) => object,
  maxBytes = JSON_REQUEST_LIMIT,
): Promise<Response> {
  const parsed = await parseJsonRequest(request, schema, maxBytes);
  if (!parsed.ok) return parsed.response;
  return safeOperation(parsed.value.requestId, () =>
    jsonResponse(operation(authenticate(request), parsed.value)),
  );
}

export function createTeacherProductHttp(
  options: TeacherProductHttpOptions,
): TeacherProductHttpApplication {
  const policy = new RequestPolicy({
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
  });
  const serverVersion = SoftwareVersionSchema.parse(options.serverVersion);
  const cookieName = validateCookieName(options.dashboardCookieName ?? DEFAULT_COOKIE_NAME);
  const secureCookie = options.secureDashboardCookie ?? true;
  const app = new Hono();
  const productPolicy = policyMiddleware(policy, false);
  const dashboardPolicy = policyMiddleware(policy, true);
  const teacherIdentity = teacherCookieIdentity(options.services.identity, cookieName);
  registerDashboardModuleRoutes({
    app,
    authenticate: teacherIdentity,
    policy: policyMiddleware(policy, false, true),
    services: options.services,
  });
  registerLiveRoute(app, policyMiddleware(policy, false, true), teacherIdentity);

  registerDashboardSessionRoutes({
    app,
    identity: options.services.identity,
    policy: productPolicy,
    mutationPolicy: policyMiddleware(policy, false, true),
    parseJson: parseJsonRequest,
    cookieToken: (request) => parseCookie(request.headers.get("cookie"), cookieName),
    sessionCookie: (token) => dashboardCookie(cookieName, token, secureCookie),
    clearedCookie: dashboardCookie(cookieName, "", secureCookie, " Max-Age=0;"),
  });
  registerTeachingRoutes({
    app,
    authenticate: teacherIdentity,
    mutationPolicy: policyMiddleware(policy, false, true),
    parseJson: parseJsonRequest,
    policy: productPolicy,
    service: options.services.teachingConfiguration,
  });
  registerSkillAuthoringRoutes({
    app,
    authenticate: teacherIdentity,
    mutationPolicy: policyMiddleware(policy, false, true),
    policy: dashboardPolicy,
    service: options.services.skillAuthoring,
  });
  if (options.governance !== undefined) {
    registerGovernanceRoutes({
      app,
      allowedHosts: options.allowedHosts,
      allowedOrigins: options.allowedOrigins,
      cookieName,
      service: options.governance.service,
      sessions: options.governance.sessions,
      digest: options.governance.digest,
      clock: options.governance.clock,
    });
  }
  app.post("/api/v1/dashboard/evaluations/query", productPolicy, (context) =>
    authenticatedJson(
      context.req.raw,
      EvaluationQuerySchema,
      teacherIdentity,
      (identity, request) => options.services.evaluations.query(identity, request),
    ),
  );
  app.post(
    "/api/v1/dashboard/evaluations/generate",
    policyMiddleware(policy, false, true),
    (context) =>
      authenticatedJson(
        context.req.raw,
        GenerateEvaluationRequestSchema,
        teacherIdentity,
        (identity, request) => options.services.evaluations.generate(identity, request),
      ),
  );
  app.post(
    "/api/v1/dashboard/evaluations/approve",
    policyMiddleware(policy, false, true),
    (context) =>
      authenticatedJson(
        context.req.raw,
        ApproveEvaluationRequestSchema,
        teacherIdentity,
        (identity, request) => options.services.evaluations.approve(identity, request),
        3 * 1_024 * 1_024,
      ),
  );

  const historyRoutes = [
    {
      prefix: "/v1/history",
      authenticate: (request: Request) =>
        options.services.identity.authenticate(bearer(request)).identity,
    },
    {
      prefix: "/api/v1/dashboard/history",
      authenticate: (request: Request) => {
        const identity = options.services.identity.authenticate(
          parseCookie(request.headers.get("cookie"), cookieName),
        ).identity;
        if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
        return identity;
      },
    },
  ];
  for (const route of historyRoutes) {
    app.post(`${route.prefix}/run`, productPolicy, (context) =>
      authenticatedJson(
        context.req.raw,
        RunHistoryQuerySchema,
        route.authenticate,
        (identity, query) => options.services.history.readRun(identity, query),
      ),
    );
    app.post(`${route.prefix}/sessions`, productPolicy, (context) =>
      authenticatedJson(
        context.req.raw,
        SessionHistoryQuerySchema,
        route.authenticate,
        (identity, query) => options.services.history.listSessions(identity, query),
      ),
    );
  }

  app.post("/api/v1/dashboard/history/classes", productPolicy, (context) =>
    authenticatedJson(
      context.req.raw,
      SessionHistoryQuerySchema,
      (request) => {
        const identity = options.services.identity.authenticate(
          parseCookie(request.headers.get("cookie"), cookieName),
        ).identity;
        if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
        return identity;
      },
      (identity, query) => options.services.history.listClassSessions(identity, query),
    ),
  );

  const sessionIdentity = (request: Request) =>
    options.services.identity.authenticate(bearer(request)).identity;
  app.post("/v1/notices/pending", productPolicy, (context) =>
    authenticatedJson(
      context.req.raw,
      PendingNoticesRequestSchema,
      sessionIdentity,
      (identity, request) => options.services.notices.pending(identity, request),
    ),
  );
  app.post("/v1/notices/acknowledge", productPolicy, (context) =>
    authenticatedJson(
      context.req.raw,
      AcknowledgeNoticeRequestSchema,
      sessionIdentity,
      (identity, request) => options.services.notices.acknowledge(identity, request),
    ),
  );
  app.post("/api/v1/dashboard/notices/query", productPolicy, (context) =>
    authenticatedJson(
      context.req.raw,
      TeacherNoticeQuerySchema,
      (request) =>
        options.services.identity.authenticate(
          parseCookie(request.headers.get("cookie"), cookieName),
        ).identity,
      (identity, request) => options.services.notices.lookup(identity, request),
    ),
  );
  app.post("/api/v1/dashboard/notices/publish", policyMiddleware(policy, false, true), (context) =>
    authenticatedJson(
      context.req.raw,
      PublishTeacherNoticeRequestSchema,
      (request) =>
        options.services.identity.authenticate(
          parseCookie(request.headers.get("cookie"), cookieName),
        ).identity,
      (identity, request) => options.services.notices.publish(identity, request),
    ),
  );

  app.post("/v1/capabilities", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(context.req.raw, CapabilitiesRequestSchema);
    if (!parsed.ok) return parsed.response;
    return jsonResponse(
      CapabilitiesResponseSchema.parse({
        capabilities: CAPABILITIES,
        requestId: parsed.value.requestId,
        serverVersion,
        supportedProtocolVersions: [CURRENT_PROTOCOL_VERSION],
      }),
    );
  });

  app.post("/v1/auth/enroll", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(context.req.raw, EnrollStudentRequestSchema);
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, async () =>
      jsonResponse(await options.services.identity.enroll(parsed.value), 201),
    );
  });

  app.post("/v1/auth/login", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(context.req.raw, CredentialLoginRequestSchema);
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, async () => {
      const response = await options.services.identity.login(parsed.value);
      const headers =
        response.principal.role === "teacher"
          ? { "set-cookie": dashboardCookie(cookieName, response.session.token, secureCookie) }
          : undefined;
      return jsonResponse(response, 200, headers);
    });
  });

  app.post("/v1/classes/bootstrap", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(context.req.raw, ClassBootstrapRequestSchema);
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () => {
      const session = options.services.identity.authenticate(bearer(context.req.raw));
      return jsonResponse(options.services.classroom.load(session.identity, parsed.value));
    });
  });

  app.post("/v1/runs/open", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(context.req.raw, OpenRunRequestSchema);
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () => {
      const session = options.services.identity.authenticate(bearer(context.req.raw));
      return jsonResponse(options.services.runs.open(session.identity, parsed.value), 201);
    });
  });

  app.post("/v1/runs/events", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(
      context.req.raw,
      AppendRunEventsRequestSchema,
      MAX_RUN_EVENTS_REQUEST_BYTES,
    );
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () =>
      jsonResponse(options.services.runs.append(bearer(context.req.raw), parsed.value)),
    );
  });

  app.post("/v1/runs/lease-renew", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(context.req.raw, RenewRunLeaseRequestSchema);
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () => {
      const session = options.services.identity.authenticate(bearer(context.req.raw));
      return jsonResponse(options.services.runs.renew(session.identity, parsed.value));
    });
  });

  app.post("/v1/runs/close", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(context.req.raw, CloseRunRequestSchema);
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () => {
      const token = bearer(context.req.raw);
      if (parsed.value.runId !== undefined) {
        const session = options.services.identity.authenticate(token);
        return jsonResponse(
          options.services.runs.closeAuthenticated(session.identity, parsed.value),
        );
      }
      return jsonResponse(
        options.services.runs.close(token, parsed.value.requestId, parsed.value.reason),
      );
    });
  });

  app.post("/v1/runs/skills/read", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(context.req.raw, RunSkillRequestSchema);
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () =>
      jsonResponse(options.services.skills.read(bearer(context.req.raw), parsed.value)),
    );
  });

  app.post("/v1/model/stream", productPolicy, async (context) => {
    const parsed = await parseJsonRequest(
      context.req.raw,
      ModelGatewayRequestSchema,
      MODEL_REQUEST_LIMIT,
    );
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () => {
      const lease = options.services.runs.authorizeLease(bearer(context.req.raw));
      const provider = options.services.providers.resolve(lease.providerRoute.providerId);
      if (provider === undefined)
        return protocolError(503, "server.error", true, parsed.value.requestId);
      const budgeted = options.services.modelUsage.providerFor(
        lease,
        parsed.value.requestId,
        provider,
      );
      if (budgeted === null)
        return protocolError(503, "server.error", false, parsed.value.requestId);
      return modelStreamResponse(
        new ModelGatewayService({
          clock: options.services.modelClock,
          retry: options.services.retry,
          route: { provider: budgeted, upstreamModel: lease.providerRoute.model },
        }),
        parsed.value,
        context.req.raw.signal,
      );
    });
  });

  app.get("/api/v1/dashboard/active-runs", dashboardPolicy, (context) => {
    const parsed = parseDashboardQuery(new URL(context.req.url));
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () => {
      const token = parseCookie(context.req.header("cookie") ?? null, cookieName);
      const session = options.services.identity.authenticate(token);
      return jsonResponse(
        options.services.dashboard.query({ identity: session.identity }, parsed.value),
      );
    });
  });

  app.notFound(() => protocolError(404, "request.invalid", false));
  app.onError(() => protocolError(500, "server.error", true));
  return Object.freeze({ fetch: app.fetch });
}
