import type { Hono, MiddlewareHandler } from "hono";
import {
  MAX_USAGE_HEALTH_REQUEST_BYTES,
  MAX_USAGE_HEALTH_RESPONSE_BYTES,
  USAGE_QUERY_PATH,
  TEACHER_HEALTH_PATH,
  UsageQuerySchema,
  UsageResponseSchema,
  TeacherHealthRequestSchema,
  TeacherHealthResponseSchema,
} from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { UsageHealthService } from "../usage-health/service.js";
import {
  boundedSkillAuthoringJson,
  parseSkillAuthoringJson,
} from "./skill-authoring-http.boundary.js";
import { classProjectionError } from "./class-projection-error.boundary.js";
import { protocolError } from "./response.js";

export function registerUsageHealthRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly service: UsageHealthService | undefined;
}): void {
  for (const path of [USAGE_QUERY_PATH, TEACHER_HEALTH_PATH]) {
    options.app.post(path, options.policy, async (context) => {
      try {
        options.authenticate(context.req.raw);
        const service = options.service;
        if (service === undefined) return protocolError(503, "server.error", false);
        const parsed = await parseSkillAuthoringJson(
          context.req.raw,
          UsageQuerySchema.or(TeacherHealthRequestSchema),
          MAX_USAGE_HEALTH_REQUEST_BYTES,
        );
        if (!parsed.ok) return parsed.response;
        const identity = options.authenticate(context.req.raw);
        const query = parsed.value;
        if (path === USAGE_QUERY_PATH && query.kind === "class-usage-query") {
          return boundedSkillAuthoringJson(
            UsageResponseSchema,
            service.queryUsage(identity, query),
            query.requestId,
            MAX_USAGE_HEALTH_RESPONSE_BYTES,
          );
        }
        if (path === TEACHER_HEALTH_PATH && query.kind === "teacher-health-read") {
          return boundedSkillAuthoringJson(
            TeacherHealthResponseSchema,
            service.readHealth(identity, query),
            query.requestId,
            MAX_USAGE_HEALTH_RESPONSE_BYTES,
          );
        }
        return protocolError(400, "request.invalid", false, query.requestId);
      } catch (error: unknown) {
        return classProjectionError(error);
      }
    });
  }
}
