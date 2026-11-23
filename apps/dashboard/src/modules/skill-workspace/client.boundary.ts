import {
  CURRENT_PROTOCOL_VERSION,
  SKILL_WORKSPACE_PATH,
  SkillWorkspaceRequestSchema,
  SkillWorkspaceResponseSchema,
  type SkillWorkspaceRequest,
  type SkillWorkspaceResponse,
} from "@marea/protocol";
import { browserRandomUUID } from "../../browser-random-uuid.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { readSkillAuthoringResponse } from "../skill-authoring/skill-authoring-response.boundary.js";

export type WorkspaceOperation = SkillWorkspaceRequest extends infer R
  ? R extends SkillWorkspaceRequest
    ? Omit<R, "protocolVersion" | "requestId" | "classId">
    : never
  : never;

type WorkspaceResult<K extends WorkspaceOperation["kind"]> = Extract<
  SkillWorkspaceResponse,
  {
    kind: K extends "assign" ? "assigned" : K extends "apply" ? "applied" : K;
  }
>;

export function createSkillWorkspaceClient(fetch: DashboardFetch) {
  return async <K extends WorkspaceOperation["kind"]>(
    classId: string,
    input: WorkspaceOperation & { kind: K },
    signal: AbortSignal,
  ): Promise<WorkspaceResult<K>> => {
    const request = SkillWorkspaceRequestSchema.parse({
      ...input,
      classId,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: `request:${browserRandomUUID()}`,
    });
    const response = await fetch(SKILL_WORKSPACE_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 422
          ? "generationProblem"
          : response.status === 409
            ? "conflict"
            : response.status === 403
              ? "forbidden"
              : "unavailable",
      );
    }
    const parsed = SkillWorkspaceResponseSchema.parse(
      JSON.parse(await readSkillAuthoringResponse(response, 4 * 1024 * 1024, signal)),
    );
    const kind =
      input.kind === "assign" ? "assigned" : input.kind === "apply" ? "applied" : input.kind;
    if (
      parsed.requestId !== request.requestId ||
      parsed.classId !== classId ||
      parsed.kind !== kind
    )
      throw new Error("unavailable");
    // The checks above establish the discriminant correlation at this boundary.
    return parsed as WorkspaceResult<K>;
  };
}
