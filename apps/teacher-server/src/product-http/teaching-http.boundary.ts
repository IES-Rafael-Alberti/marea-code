import {
  MAX_TEACHING_CONFIGURATION_BYTES,
  SaveTeachingConfigurationRequestSchema,
  TeachingCatalogQuerySchema,
  TeachingClassesQuerySchema,
  TeachingConfigurationQuerySchema,
  type RequestId,
} from "@marea/protocol";
import type { Hono, MiddlewareHandler } from "hono";
import type * as z from "zod";

import { TeacherDomainError } from "../identity/errors.js";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { ProductTeachingConfigurationService } from "../teaching/configuration/dashboard-contracts.js";
import {
  TeachingConfigurationError,
  teachingConfigurationError,
} from "../teaching/configuration/dashboard-errors.js";
import { jsonResponse, protocolError } from "./response.js";

/** Catalog/query requests keep the existing dashboard payload bound. */
const TEACHING_QUERY_BYTES = 64 * 1_024;
/** All teaching responses share the 4 MiB UTF-8 configuration bound (ADR 0021). */
const TEACHING_RESPONSE_BYTES = 4 * 1_024 * 1_024;

export interface TeachingRouteDependencies {
  readonly app: Hono;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly mutationPolicy: MiddlewareHandler;
  readonly parseJson: <T>(
    request: Request,
    schema: z.ZodType<T>,
    maxBytes: number,
  ) => Promise<{ ok: true; value: T } | { ok: false; response: Response }>;
  readonly policy: MiddlewareHandler;
  readonly service: ProductTeachingConfigurationService;
}

interface TeachingRouteQuery {
  readonly requestId: RequestId;
}

function sanitizedFailure(error: unknown, requestId: RequestId): Response {
  if (error instanceof TeachingConfigurationError || error instanceof TeacherDomainError) {
    return teachingConfigurationError(error, requestId);
  }
  return protocolError(500, "server.error", true, requestId);
}

/** Enforces the shared UTF-8 byte bound on awaited teaching responses. */
async function teachingJson(operation: Promise<object>): Promise<Response> {
  const body = JSON.stringify(await operation);
  if (new TextEncoder().encode(body).byteLength > TEACHING_RESPONSE_BYTES) {
    // Sanitized by the route handler as a retryable server error without details.
    throw new Error();
  }
  return jsonResponse(JSON.parse(body) as object);
}

/** Registers the teacher-configuration routes on the existing Hono application. */
export function registerTeachingRoutes(dependencies: TeachingRouteDependencies): void {
  const register = <T extends TeachingRouteQuery>(
    path: string,
    schema: z.ZodType<T>,
    policy: MiddlewareHandler,
    maxBytes: number,
    operation: (identity: AuthenticatedIdentity, query: T) => Promise<object>,
  ): void => {
    dependencies.app.post(path, policy, async (context) => {
      const parsed = await dependencies.parseJson(context.req.raw, schema, maxBytes);
      if (!parsed.ok) return parsed.response;
      try {
        const identity = dependencies.authenticate(context.req.raw);
        return await teachingJson(operation(identity, parsed.value));
      } catch (error: unknown) {
        return sanitizedFailure(error, parsed.value.requestId);
      }
    });
  };
  const service = dependencies.service;
  register(
    "/api/v1/dashboard/teaching/classes",
    TeachingClassesQuerySchema,
    dependencies.policy,
    TEACHING_QUERY_BYTES,
    (identity, query) => service.classes(identity, query),
  );
  register(
    "/api/v1/dashboard/teaching/read",
    TeachingConfigurationQuerySchema,
    dependencies.policy,
    TEACHING_QUERY_BYTES,
    (identity, query) => service.read(identity, query),
  );
  register(
    "/api/v1/dashboard/teaching/catalog",
    TeachingCatalogQuerySchema,
    dependencies.policy,
    TEACHING_QUERY_BYTES,
    (identity, query) => service.catalog(identity, query),
  );
  register(
    "/api/v1/dashboard/teaching/save",
    SaveTeachingConfigurationRequestSchema,
    dependencies.mutationPolicy,
    MAX_TEACHING_CONFIGURATION_BYTES,
    (identity, request) => service.save(identity, request),
  );
}
