import type { Hono, MiddlewareHandler } from "hono";
import {
  MAX_REVIEWED_EVIDENCE_REQUEST_BYTES,
  MAX_REVIEWED_EVIDENCE_RESPONSE_BYTES,
  REVIEWED_EVIDENCE_PATH,
  ReviewedEvidenceQuerySchema,
  ReviewedEvidenceResponseSchema,
} from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { ReviewedEvidenceService } from "../reviewed-evidence/service.js";
import {
  boundedSkillAuthoringJson,
  parseSkillAuthoringJson,
} from "./skill-authoring-http.boundary.js";
import { classProjectionError } from "./class-projection-error.boundary.js";
import { protocolError } from "./response.js";

export function registerReviewedEvidenceRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly service: ReviewedEvidenceService | undefined;
}): void {
  for (const path of ["students", "criteria", "history"]) {
    options.app.post(`${REVIEWED_EVIDENCE_PATH}${path}`, options.policy, async (context) => {
      try {
        options.authenticate(context.req.raw);
        const service = options.service;
        if (service === undefined) return protocolError(503, "server.error", false);
        const parsed = await parseSkillAuthoringJson(
          context.req.raw,
          ReviewedEvidenceQuerySchema,
          MAX_REVIEWED_EVIDENCE_REQUEST_BYTES,
        );
        if (!parsed.ok) return parsed.response;
        const identity = options.authenticate(context.req.raw);
        const query = parsed.value;
        if (path === query.kind) {
          return boundedSkillAuthoringJson(
            ReviewedEvidenceResponseSchema,
            service.read(identity, query),
            query.requestId,
            MAX_REVIEWED_EVIDENCE_RESPONSE_BYTES,
          );
        }
        return protocolError(400, "request.invalid", false, query.requestId);
      } catch (error: unknown) {
        return classProjectionError(error);
      }
    });
  }
}
