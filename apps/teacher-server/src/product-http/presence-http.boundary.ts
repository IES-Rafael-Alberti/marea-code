import type { Hono, MiddlewareHandler } from "hono";
import * as z from "zod";
import { RequestIdSchema, type RequestId } from "@marea/protocol";
import type { TeacherProductServices } from "./contracts.js";
import type { TeachingRouteDependencies } from "./teaching-http.boundary.js";
import { jsonResponse } from "./response.js";
export function registerPresenceRoute(
  app: Hono,
  policy: MiddlewareHandler,
  services: TeacherProductServices,
  parseJsonRequest: TeachingRouteDependencies["parseJson"],
  bearer: (request: Request) => string,
  safeOperation: (id: RequestId, work: () => Response) => Promise<Response>,
): void {
  app.post("/v1/runs/presence", policy, async (context) => {
    const parsed = await parseJsonRequest(
      context.req.raw,
      z.object({ requestId: RequestIdSchema }).strict(),
      4096,
    );
    if (!parsed.ok) return parsed.response;
    return safeOperation(parsed.value.requestId, () => {
      const lease = services.runs.authorizeLease(bearer(context.req.raw));
      services.educationalInsights?.heartbeat(lease.runId);
      return jsonResponse({ requestId: parsed.value.requestId });
    });
  });
}
