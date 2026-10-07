import type { Hono, MiddlewareHandler } from "hono";
import { isJson, readRequest } from "@marea/transport-server";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import { ServerSettingsError, type ServerSettingsEndpoint } from "../server-settings/contracts.js";
import { jsonResponse, protocolError } from "./response.js";
export function registerServerSettingsRoutes(options: {
  app: Hono;
  policy: MiddlewareHandler;
  authenticate(request: Request): AuthenticatedIdentity;
  service: ServerSettingsEndpoint | undefined;
  path?: string;
}) {
  options.app.post(
    options.path ?? "/api/v1/dashboard/server-settings",
    options.policy,
    async (context) => {
      try {
        const identity = options.authenticate(context.req.raw);
        if (options.service === undefined) throw new ServerSettingsError(503);
        if (!isJson(context.req.header("content-type"))) throw new ServerSettingsError(400);
        const body = await readRequest(context.req.raw, 262144);
        if (body instanceof Response) return body;
        return jsonResponse(
          await options.service.execute(
            identity,
            new TextEncoder().encode(body),
            context.req.raw.signal,
          ),
        );
      } catch (error) {
        const status =
          error instanceof ServerSettingsError
            ? error.status
            : error instanceof TeacherDomainError
              ? 401
              : 500;
        return protocolError(
          status,
          status === 401 ? "auth.invalid" : status >= 500 ? "server.error" : "request.invalid",
          false,
        );
      }
    },
  );
}
