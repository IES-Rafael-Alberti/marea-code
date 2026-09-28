import {
  CredentialLoginRequestSchema,
  CredentialLogoutRequestSchema,
  CURRENT_PROTOCOL_VERSION,
  DashboardSessionQuerySchema,
  DashboardSessionResponseSchema,
  type RequestId,
  type SafePrincipal,
} from "@marea/protocol";
import type { Hono, MiddlewareHandler } from "hono";
import type * as z from "zod";

import { TeacherDomainError } from "../identity/errors.js";
import type { ProductIdentityService } from "./contracts.js";
import { jsonResponse, protocolError } from "./response.js";
import type { TeachingRouteDependencies } from "./teaching-http.boundary.js";

const SESSION_REQUEST_BYTES = 4 * 1_024;

export interface DashboardSessionRouteDependencies {
  readonly app: Hono;
  readonly identity: ProductIdentityService;
  /** Reads the session query; the browser sends the cookie on every dashboard request. */
  readonly policy: MiddlewareHandler;
  /** Sign-in and sign-out change the session, so they require the dashboard origin. */
  readonly mutationPolicy: MiddlewareHandler;
  readonly parseJson: TeachingRouteDependencies["parseJson"];
  /** The dashboard session token from the cookie; throws `auth.invalid` when absent. */
  readonly cookieToken: (request: Request) => string;
  readonly sessionCookie: (token: string) => string;
  readonly clearedCookie: string;
}

function forbidden(): TeacherDomainError {
  return new TeacherDomainError("dashboard.forbidden");
}

function failure(error: unknown, requestId: RequestId): Response {
  if (error instanceof TeacherDomainError && error.code === "auth.busy")
    return protocolError(503, "server.error", true, requestId);
  if (error instanceof TeacherDomainError && error.code === "auth.invalid")
    return protocolError(401, "auth.invalid", false, requestId);
  if (error instanceof TeacherDomainError && error.code === "dashboard.forbidden")
    return protocolError(403, "request.invalid", false, requestId);
  return protocolError(500, "server.error", true, requestId);
}

function sessionBody(requestId: RequestId, principal: SafePrincipal): object {
  if (principal.role !== "teacher") throw forbidden();
  return DashboardSessionResponseSchema.parse({
    kind: "dashboard-session",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId,
    // Only the safe fields leave the server, whatever else the identity carries.
    principal: { role: principal.role, displayName: principal.displayName },
  });
}

/**
 * Teacher sign-in, session and sign-out for the browser dashboard. The session token is only ever
 * placed in the HttpOnly cookie, and a signed-in student never keeps a session from these routes.
 */
export function registerDashboardSessionRoutes(dependencies: DashboardSessionRouteDependencies) {
  const { app, identity } = dependencies;
  const route = <T extends { readonly requestId: RequestId }>(
    path: string,
    policy: MiddlewareHandler,
    schema: z.ZodType<T>,
    operation: (request: Request, body: T) => Promise<Response> | Response,
  ) => {
    app.post(path, policy, async (context) => {
      const parsed = await dependencies.parseJson(context.req.raw, schema, SESSION_REQUEST_BYTES);
      if (!parsed.ok) return parsed.response;
      try {
        return await operation(context.req.raw, parsed.value);
      } catch (error: unknown) {
        return failure(error, parsed.value.requestId);
      }
    });
  };

  route(
    "/api/v1/dashboard/session",
    dependencies.policy,
    DashboardSessionQuerySchema,
    (request, query) =>
      jsonResponse(
        sessionBody(
          query.requestId,
          identity.authenticate(dependencies.cookieToken(request)).principal,
        ),
      ),
  );

  route(
    "/api/v1/dashboard/session/login",
    dependencies.mutationPolicy,
    CredentialLoginRequestSchema,
    async (_request, login) => {
      const signedIn = await identity.login(login);
      if (signedIn.principal.role !== "teacher") {
        identity.logout(signedIn.session.token, login.requestId);
        throw forbidden();
      }
      return jsonResponse(sessionBody(login.requestId, signedIn.principal), 200, {
        "set-cookie": dependencies.sessionCookie(signedIn.session.token),
      });
    },
  );

  route(
    "/api/v1/dashboard/session/logout",
    dependencies.mutationPolicy,
    CredentialLogoutRequestSchema,
    (request, logout) =>
      jsonResponse(identity.logout(dependencies.cookieToken(request), logout.requestId), 200, {
        "set-cookie": dependencies.clearedCookie,
      }),
  );
}
