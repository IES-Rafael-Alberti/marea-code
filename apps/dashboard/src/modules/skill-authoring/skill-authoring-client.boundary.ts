import {
  CURRENT_PROTOCOL_VERSION,
  MAX_SKILL_RESPONSE_BYTES,
  MAX_TEACHING_CONFIGURATION_BYTES,
  RequestIdSchema,
  SkillAuthoringCopyRequestSchema,
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringReadRequestSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringSaveRequestSchema,
  SkillAuthoringSaveResponseSchema,
  SkillAuthoringValidateRequestSchema,
  SkillAuthoringValidateResponseSchema,
  TeachingCatalogQuerySchema,
  TeachingCatalogResponseSchema,
  TeachingClassesQuerySchema,
  TeachingClassesResponseSchema,
  type SkillAuthoringCopyResponse,
  type SkillAuthoringReadResponse,
  type SkillAuthoringSaveResponse,
  type SkillAuthoringValidateResponse,
  type TeachingCatalogResponse,
  type TeachingClassesResponse,
} from "@marea/protocol";
import type * as z from "zod";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import type {
  SkillAuthoringClient,
  SkillAuthoringClientFailure,
  SkillAuthoringProblem,
} from "./skill-authoring-contracts.js";
import {
  readSkillAuthoringResponse,
  serializeSkillAuthoringRequest,
} from "./skill-authoring-response.boundary.js";

const TEACHING_PATH = "/api/v1/dashboard/teaching";
const QUERY_BYTES = 64 * 1_024;

function authoringPath(): string {
  return "/api/v1/dashboard/skill-authoring";
}

interface ResponseWithRequestId {
  readonly requestId: string;
}
type FailureMode = "validate" | "write";

/**
 * The dashboard transport is deliberately small and boring: all authority is
 * supplied by the server session, while this boundary owns framing, bounds,
 * and response correlation.
 */
export function createSkillAuthoringClient(
  fetchRequest: DashboardFetch,
  createRequestId: () => string = () => `request:${crypto.randomUUID()}`,
): SkillAuthoringClient {
  function requestId(): string {
    return RequestIdSchema.parse(createRequestId());
  }

  async function post<T extends ResponseWithRequestId>(
    path: string,
    body: T extends never ? never : object,
    serialized: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    responseLimit: number,
    matchesClass: (data: T) => boolean = () => true,
    mode?: FailureMode,
  ): Promise<T> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetchRequest(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: serialized,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw failure(modeProblem(mode, "load"), "The skill authoring request could not be sent.");
    }

    if (!response.ok) {
      throw failure(
        responseProblem(response.status, modeProblem(mode, "load")),
        "The skill authoring request failed.",
      );
    }

    let text: string;
    try {
      text = await readSkillAuthoringResponse(response, responseLimit, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof RangeError) {
        throw failure(modeProblem(mode, "load"), "The skill authoring response is too large.");
      }
      throw failure(modeProblem(mode, "load"), "The skill authoring response could not be read.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw failure(modeProblem(mode, "load"), "The skill authoring response is not valid JSON.");
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw failure(
        modeProblem(mode, "load"),
        "The skill authoring response violates its contract.",
      );
    }
    if (result.data.requestId !== (body as { requestId: string }).requestId) {
      throw failure(
        modeProblem(mode, "load"),
        "The skill authoring response does not match its request.",
      );
    }
    if (!matchesClass(result.data)) {
      throw failure(
        modeProblem(mode, "load"),
        "The skill authoring response belongs to another class.",
      );
    }
    return result.data;
  }

  return Object.freeze<SkillAuthoringClient>({
    classes(afterClassId, signal): Promise<TeachingClassesResponse> {
      const body = TeachingClassesQuerySchema.parse({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: requestId(),
        kind: "teaching-classes-query",
        afterClassId,
      });
      return post(
        `${TEACHING_PATH}/classes`,
        body,
        serializeSkillAuthoringRequest(body, QUERY_BYTES),
        TeachingClassesResponseSchema,
        signal,
        MAX_TEACHING_CONFIGURATION_BYTES,
      );
    },

    catalog(classId, afterSkillId, signal): Promise<TeachingCatalogResponse> {
      const body = TeachingCatalogQuerySchema.parse({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: requestId(),
        kind: "teaching-catalog-query",
        classId,
        afterSkillId,
      });
      return post(
        `${TEACHING_PATH}/catalog`,
        body,
        serializeSkillAuthoringRequest(body, QUERY_BYTES),
        TeachingCatalogResponseSchema,
        signal,
        MAX_TEACHING_CONFIGURATION_BYTES,
        (result) => result.classId === classId,
      );
    },

    readPersonal(classId, slug, signal): Promise<SkillAuthoringReadResponse> {
      const body = SkillAuthoringReadRequestSchema.parse({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: requestId(),
        classId,
        kind: "skill-authoring-read",
        target: { scope: "personal", slug },
      });
      return post(
        `${authoringPath()}/read`,
        body,
        serializeSkillAuthoringRequest(body, QUERY_BYTES),
        SkillAuthoringReadResponseSchema,
        signal,
        MAX_SKILL_RESPONSE_BYTES,
        (result) => result.classId === classId,
      );
    },

    readCatalog(classId, skillId, signal): Promise<SkillAuthoringReadResponse> {
      const body = SkillAuthoringReadRequestSchema.parse({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: requestId(),
        classId,
        kind: "skill-authoring-read",
        target: { scope: "catalog", skillId },
      });
      return post(
        `${authoringPath()}/read`,
        body,
        serializeSkillAuthoringRequest(body, QUERY_BYTES),
        SkillAuthoringReadResponseSchema,
        signal,
        MAX_SKILL_RESPONSE_BYTES,
        (result) => result.classId === classId,
      );
    },

    validate(classId, draft, signal): Promise<SkillAuthoringValidateResponse> {
      const body = SkillAuthoringValidateRequestSchema.parse({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: requestId(),
        classId,
        kind: "skill-authoring-validate",
        draft,
      });
      return post(
        `${authoringPath()}/validate`,
        body,
        serializeSkillAuthoringRequest(body, MAX_SKILL_RESPONSE_BYTES),
        SkillAuthoringValidateResponseSchema,
        signal,
        MAX_SKILL_RESPONSE_BYTES,
        (result) => result.classId === classId,
        "validate",
      );
    },

    save(classId, draft, expectedDigest, signal): Promise<SkillAuthoringSaveResponse> {
      const body = SkillAuthoringSaveRequestSchema.parse({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: requestId(),
        classId,
        kind: "skill-authoring-save",
        draft,
        expectedDigest,
      });
      return post(
        `${authoringPath()}/save`,
        body,
        serializeSkillAuthoringRequest(body, MAX_SKILL_RESPONSE_BYTES),
        SkillAuthoringSaveResponseSchema,
        signal,
        MAX_SKILL_RESPONSE_BYTES,
        (result) => result.classId === classId,
        "write",
      );
    },

    copy(classId, sourceSkillId, sourceDigest, slug, signal): Promise<SkillAuthoringCopyResponse> {
      const body = SkillAuthoringCopyRequestSchema.parse({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: requestId(),
        classId,
        kind: "skill-authoring-copy",
        sourceSkillId,
        sourceDigest,
        slug,
      });
      return post(
        `${authoringPath()}/copy`,
        body,
        serializeSkillAuthoringRequest(body, QUERY_BYTES),
        SkillAuthoringCopyResponseSchema,
        signal,
        MAX_SKILL_RESPONSE_BYTES,
        (result) => result.classId === classId,
        "write",
      );
    },
  });
}

function modeProblem(
  mode: FailureMode | undefined,
  fallback: SkillAuthoringProblem,
): SkillAuthoringProblem {
  if (mode === "write") return "uncertain";
  if (mode === "validate") return "invalid";
  return fallback;
}

function responseProblem(status: number, fallback: SkillAuthoringProblem): SkillAuthoringProblem {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 422) return "skill-unavailable";
  if (status === 400 || status === 413) return "invalid";
  return fallback;
}

function failure(code: SkillAuthoringProblem, message: string): SkillAuthoringClientFailure {
  return Object.assign(new Error(message), { code });
}
