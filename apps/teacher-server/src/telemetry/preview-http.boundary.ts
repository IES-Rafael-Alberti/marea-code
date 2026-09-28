import { Hono } from "hono";
import {
  MAX_TELEMETRY_PREVIEW_BYTES,
  TELEMETRY_PREVIEW_PATH,
  TelemetryPreviewRequestSchema,
  TelemetryPreviewResponseSchema,
} from "@marea/protocol";
import { RequestPolicy } from "@marea/transport-server";
import type {
  ProductIdentityService,
  TeacherProductHttpApplication,
} from "../product-http/contracts.js";
import { teacherCookieIdentity } from "../product-http/live-http.boundary.js";
import { protocolError } from "../product-http/response.js";
import {
  authoringErrorResponse,
  boundedSkillAuthoringJson,
  parseSkillAuthoringJson,
} from "../product-http/skill-authoring-http.boundary.js";
import type { TelemetryPreviewService } from "./preview-service.js";

export interface TelemetryPreviewHttpOptions {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly identity: ProductIdentityService;
  readonly service: TelemetryPreviewService;
}

/** Narrow factory: identical cookie authority and transport policy to the product dashboard. */
export function createTelemetryPreviewHttp(
  options: TelemetryPreviewHttpOptions,
): TeacherProductHttpApplication {
  const app = new Hono();
  const policy = new RequestPolicy(options);
  const authenticate = teacherCookieIdentity(options.identity, "marea_teacher_session");
  app.post(TELEMETRY_PREVIEW_PATH, async (context) => {
    if (!policy.evaluate(context.req.raw).allowed) {
      return protocolError(403, "request.invalid", false);
    }
    const parsed = await parseSkillAuthoringJson(
      context.req.raw,
      TelemetryPreviewRequestSchema,
      MAX_TELEMETRY_PREVIEW_BYTES,
    );
    if (!parsed.ok) return parsed.response;
    try {
      const response = options.service.preview(authenticate(context.req.raw), parsed.value);
      return boundedSkillAuthoringJson(
        TelemetryPreviewResponseSchema,
        response,
        parsed.value.requestId,
        MAX_TELEMETRY_PREVIEW_BYTES,
      );
    } catch (error: unknown) {
      return authoringErrorResponse(error, parsed.value.requestId);
    }
  });
  app.notFound(() => protocolError(404, "request.invalid", false));
  app.onError(() => protocolError(500, "server.error", true));
  return { fetch: app.fetch };
}
