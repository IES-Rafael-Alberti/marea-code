import type { Hono, MiddlewareHandler } from "hono";
import { isJson, readRequest } from "@marea/transport-server";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import { SessionExportError, type SessionExportEndpoint } from "../session-export/contracts.js";
import { jsonResponse, protocolError } from "./response.js";

export function registerSessionExportRoutes(options: {
  app: Hono;
  policy: MiddlewareHandler;
  authenticate(request: Request): AuthenticatedIdentity;
  service: SessionExportEndpoint | undefined;
}) {
  for (const action of ["download", "students"] as const) {
    options.app.post(
      `/api/v1/dashboard/session-export/${action}`,
      options.policy,
      async (context) => {
        try {
          const identity = options.authenticate(context.req.raw);
          if (options.service === undefined) throw new SessionExportError(503);
          if (action === "students")
            return jsonResponse({ students: options.service.students(identity) });
          if (!isJson(context.req.header("content-type"))) throw new SessionExportError(400);
          const input = await readRequest(context.req.raw, 4096);
          if (input instanceof Response) return input;
          return new Response(options.service.download(identity, new TextEncoder().encode(input)), {
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": 'attachment; filename="marea-sessions.zip"',
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          const status =
            error instanceof SessionExportError
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
}
