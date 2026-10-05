import type { Hono, MiddlewareHandler } from "hono";
import {
  ClassBootstrapRequestSchema,
  ClassSelectRequestSchema,
  type RequestId,
} from "@marea/protocol";
import type * as z from "zod";

import type { TeacherProductServices } from "./contracts.js";
import type { ParseResult } from "./request-json.boundary.js";
import { jsonResponse } from "./response.js";

/** A student session bootstraps its class, or first chooses one of its classes. */
export function registerClassroomRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly parseJson: <T>(request: Request, schema: z.ZodType<T>) => Promise<ParseResult<T>>;
  readonly safeOperation: (
    requestId: RequestId,
    operation: () => Response | Promise<Response>,
  ) => Promise<Response>;
  readonly bearer: (request: Request) => string;
  readonly services: Pick<TeacherProductServices, "classroom" | "identity">;
}): void {
  const { app, services } = options;
  app.post("/v1/classes/bootstrap", options.policy, async (context) => {
    const parsed = await options.parseJson(context.req.raw, ClassBootstrapRequestSchema);
    if (!parsed.ok) return parsed.response;
    return options.safeOperation(parsed.value.requestId, () => {
      const session = services.identity.authenticate(options.bearer(context.req.raw));
      return jsonResponse(services.classroom.load(session.identity, parsed.value));
    });
  });
  app.post("/v1/classes/select", options.policy, async (context) => {
    const parsed = await options.parseJson(context.req.raw, ClassSelectRequestSchema);
    if (!parsed.ok) return parsed.response;
    return options.safeOperation(parsed.value.requestId, () => {
      const identity = services.identity.selectClass(
        options.bearer(context.req.raw),
        parsed.value.classId,
      );
      return jsonResponse(
        services.classroom.load(
          identity,
          ClassBootstrapRequestSchema.parse({
            kind: "class-bootstrap",
            protocolVersion: parsed.value.protocolVersion,
            requestId: parsed.value.requestId,
          }),
        ),
      );
    });
  });
}
