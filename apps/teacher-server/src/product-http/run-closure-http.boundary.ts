import type { Hono, MiddlewareHandler } from "hono";
import {
  ClassRunsCloseRequestSchema,
  TeacherRunCloseRequestSchema,
  type RequestId,
} from "@marea/protocol";
import type * as z from "zod";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { RunClosureService } from "../sessions/run-closure-service.js";
import { safeOperation } from "./domain-error.boundary.js";
import { parseJsonRequest } from "./request-json.boundary.js";
import { jsonResponse } from "./response.js";

/**
 * Teacher-cookie routes that end student runs. They are registered only when the host composes
 * a closure service, and the mutation policy requires an allowed Origin.
 */
export function registerRunClosureRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly service: Pick<RunClosureService, "closeRun" | "closeClassRuns"> | undefined;
}): void {
  const service = options.service;
  if (service === undefined) return;
  const register = <T extends { readonly requestId: RequestId }>(
    path: string,
    schema: z.ZodType<T>,
    operation: (identity: AuthenticatedIdentity, request: T) => object,
  ) => {
    options.app.post(path, options.policy, async (context) => {
      const parsed = await parseJsonRequest(context.req.raw, schema);
      if (!parsed.ok) return parsed.response;
      return safeOperation(parsed.value.requestId, () =>
        jsonResponse(operation(options.authenticate(context.req.raw), parsed.value)),
      );
    });
  };
  register("/api/v1/dashboard/runs/close", TeacherRunCloseRequestSchema, (identity, request) =>
    service.closeRun(identity, request),
  );
  register(
    "/api/v1/dashboard/classes/close-runs",
    ClassRunsCloseRequestSchema,
    (identity, request) => service.closeClassRuns(identity, request),
  );
}
