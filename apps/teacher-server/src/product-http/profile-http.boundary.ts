import type { Hono, MiddlewareHandler } from "hono";
import {
  MAX_DASHBOARD_PROFILE_REQUEST_BYTES,
  MAX_DASHBOARD_PROFILE_RESPONSE_BYTES,
} from "@marea/protocol";
import { isJson, readRequest } from "@marea/transport-server";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import {
  DashboardProfileError,
  type DashboardProfileEndpoint,
} from "../dashboard-profiles/contracts.js";
import { jsonResponse, protocolError } from "./response.js";

async function bodyBytes(request: Request): Promise<Uint8Array> {
  if (!isJson(request.headers.get("content-type") ?? undefined))
    throw new DashboardProfileError(400);
  const body = await readRequest(request, MAX_DASHBOARD_PROFILE_REQUEST_BYTES);
  if (body instanceof Response) throw new DashboardProfileError(body.status === 413 ? 413 : 400);
  return new TextEncoder().encode(body);
}
export function registerDashboardProfileRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly service: DashboardProfileEndpoint | undefined;
}): void {
  for (const operation of ["read", "catalog", "save", "reset"]) {
    options.app.post(`/api/v1/dashboard/profiles/${operation}`, options.policy, async (context) => {
      try {
        const identity = options.authenticate(context.req.raw);
        if (options.service === undefined) {
          const response = protocolError(503, "server.error", false);
          response.headers.set("x-marea-profile-mode", "legacy");
          return response;
        }
        const bytes = await bodyBytes(context.req.raw);
        const result = options.service.execute(identity, operation, bytes);
        if (
          new TextEncoder().encode(JSON.stringify(result)).byteLength >
          MAX_DASHBOARD_PROFILE_RESPONSE_BYTES
        )
          throw new Error();
        return jsonResponse(result);
      } catch (error) {
        if (error instanceof DashboardProfileError)
          return protocolError(
            error.status,
            error.status >= 500 ? "server.error" : "request.invalid",
            false,
            error.requestId,
          );
        if (error instanceof TeacherDomainError)
          return protocolError(
            error.code === "auth.invalid" ? 401 : 403,
            error.code === "auth.invalid" ? "auth.invalid" : "request.invalid",
            false,
          );
        return protocolError(500, "server.error", false);
      }
    });
  }
}
