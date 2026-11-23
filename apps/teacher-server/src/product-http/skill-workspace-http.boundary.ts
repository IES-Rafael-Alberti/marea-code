import type { Hono, MiddlewareHandler } from "hono";
import {
  SKILL_WORKSPACE_PATH,
  SkillWorkspaceRequestSchema,
  SkillWorkspaceResponseSchema,
} from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { SkillWorkspaceService } from "../teaching/skills/workspace-service.boundary.js";
import { SkillSnapshotError } from "../teaching/skills/index.js";
import {
  boundedSkillAuthoringJson,
  parseSkillAuthoringJson,
} from "./skill-authoring-http.boundary.js";
import { protocolError } from "./response.js";
import { SkillGenerationError } from "../teaching/skills/generate-skill.js";
import { SkillAuthoringError } from "../teaching/authoring/errors.js";

export function registerSkillWorkspaceRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly service: Pick<SkillWorkspaceService, "execute"> | undefined;
}): void {
  options.app.post(SKILL_WORKSPACE_PATH, options.policy, async (context) => {
    try {
      const identity = options.authenticate(context.req.raw);
      if (options.service === undefined) return protocolError(503, "server.error", false);
      const parsed = await parseSkillAuthoringJson(
        context.req.raw,
        SkillWorkspaceRequestSchema,
        131072,
      );
      if (!parsed.ok) return parsed.response;
      const result = await options.service.execute(identity, parsed.value, context.req.raw.signal);
      return boundedSkillAuthoringJson(
        SkillWorkspaceResponseSchema,
        result,
        parsed.value.requestId,
      );
    } catch (error) {
      if (error instanceof SkillGenerationError)
        return protocolError(422, "request.invalid", false);
      if (error instanceof SkillAuthoringError && error.code === "STALE_SKILL_DIGEST")
        return protocolError(409, "request.invalid", false);
      if (error instanceof TeacherDomainError) {
        if (error.code === "request.conflict") return protocolError(409, "request.invalid", false);
        return protocolError(error.code === "auth.invalid" ? 401 : 403, "auth.invalid", false);
      }
      if (error instanceof SkillSnapshotError) return protocolError(409, "request.invalid", false);
      return protocolError(500, "server.error", false);
    }
  });
}
