import type { Hono, MiddlewareHandler } from "hono";
import {
  EXTERNAL_ACCESS_PATH,
  ExternalAccessRequestSchema,
  ExternalAuthBeginRequestSchema,
  ExternalAuthCompleteRequestSchema,
  ExternalAuthProvidersRequestSchema,
  type RequestId,
} from "@marea/protocol";

import type * as z from "zod";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { ExternalIdentityServices } from "./contracts.js";
import type { ParseResult } from "./request-json.boundary.js";
import { jsonResponse } from "./response.js";

type ParseJson = <T>(request: Request, schema: z.ZodType<T>) => Promise<ParseResult<T>>;
type SafeOperation = (
  requestId: RequestId,
  operation: () => Response | Promise<Response>,
) => Promise<Response>;

/** Registered only while an installed identity provider plugin is configured. */
export function registerExternalIdentityRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly mutationPolicy: MiddlewareHandler;
  readonly parseJson: ParseJson;
  readonly safeOperation: SafeOperation;
  readonly teacher: (request: Request) => AuthenticatedIdentity;
  readonly services: ExternalIdentityServices | undefined;
}): void {
  const { app, services } = options;
  if (services === undefined) return;
  app.post("/v1/auth/external/providers", options.policy, async (context) => {
    const parsed = await options.parseJson(context.req.raw, ExternalAuthProvidersRequestSchema);
    if (!parsed.ok) return parsed.response;
    return jsonResponse(services.signIn.providers(parsed.value));
  });
  app.post("/v1/auth/external/begin", options.policy, async (context) => {
    const parsed = await options.parseJson(context.req.raw, ExternalAuthBeginRequestSchema);
    if (!parsed.ok) return parsed.response;
    return options.safeOperation(parsed.value.requestId, () =>
      jsonResponse(services.signIn.begin(parsed.value)),
    );
  });
  app.post("/v1/auth/external/complete", options.policy, async (context) => {
    const parsed = await options.parseJson(context.req.raw, ExternalAuthCompleteRequestSchema);
    if (!parsed.ok) return parsed.response;
    return options.safeOperation(parsed.value.requestId, async () =>
      jsonResponse(await services.signIn.complete(parsed.value)),
    );
  });
  app.post(EXTERNAL_ACCESS_PATH, options.mutationPolicy, async (context) => {
    const parsed = await options.parseJson(context.req.raw, ExternalAccessRequestSchema);
    if (!parsed.ok) return parsed.response;
    return options.safeOperation(parsed.value.requestId, () =>
      jsonResponse(services.access.execute(options.teacher(context.req.raw), parsed.value)),
    );
  });
}
