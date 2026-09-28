import type { Hono, MiddlewareHandler } from "hono";
import * as z from "zod";
import {
  EDUCATIONAL_INSIGHTS_PATH,
  InsightsRequestSchema,
  MAX_INSIGHTS_BYTES,
} from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { EducationalInsightsService } from "../educational-insights/service.js";
import {
  parseSkillAuthoringJson,
  boundedSkillAuthoringJson,
} from "./skill-authoring-http.boundary.js";
import { classProjectionError } from "./class-projection-error.boundary.js";
import { protocolError } from "./response.js";
export function registerEducationalInsightsRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly service: EducationalInsightsService | undefined;
}): void {
  options.app.post(EDUCATIONAL_INSIGHTS_PATH, options.policy, async (context) => {
    try {
      options.authenticate(context.req.raw);
      if (options.service === undefined) return protocolError(503, "server.error", false);
      const parsed = await parseSkillAuthoringJson(context.req.raw, InsightsRequestSchema, 16384);
      if (!parsed.ok) return parsed.response;
      const result = options.service.read(options.authenticate(context.req.raw), parsed.value);
      return boundedSkillAuthoringJson(
        z.object({
          protocolVersion: z.string(),
          requestId: z.string(),
          classId: z.string(),
          kind: z.string(),
          data: z.unknown(),
        }),
        result as object,
        parsed.value.requestId,
        MAX_INSIGHTS_BYTES,
      );
    } catch (error) {
      return classProjectionError(error);
    }
  });
}
