import { browserRandomUUID } from "../../browser-random-uuid.js";
import {
  CURRENT_PROTOCOL_VERSION,
  MAX_TEACHING_CONFIGURATION_BYTES,
  RequestIdSchema,
  SaveTeachingConfigurationRequestSchema,
  SaveTeachingConfigurationResponseSchema,
  TeachingCatalogQuerySchema,
  TeachingCatalogResponseSchema,
  TeachingClassesQuerySchema,
  TeachingClassesResponseSchema,
  TeachingConfigurationQuerySchema,
  TeachingConfigurationResponseSchema,
} from "@marea/protocol";
import type * as z from "zod";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { readTeachingResponse } from "./teaching-response.boundary.js";
import type {
  TeachingClient,
  TeachingClientFailure,
  TeachingProblem,
} from "./teaching-contracts.js";

const TEACHING_PATH = "/api/v1/dashboard/teaching";

export function createTeachingClient(
  fetchRequest: DashboardFetch,
  createRequestId: () => string = () => `request:${browserRandomUUID()}`,
): TeachingClient {
  async function post<T extends { requestId: string }>(
    path: string,
    body: { readonly requestId: string },
    schema: z.ZodType<T>,
    signal: AbortSignal,
    readProblem: TeachingProblem,
    classId?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchRequest(`${TEACHING_PATH}/${path}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw teachingFailure(readProblem, "The teaching request could not be sent.");
    }
    if (!response.ok) {
      throw teachingFailure(
        responseProblem(response.status) ?? readProblem,
        "The teaching request failed.",
      );
    }
    let text: string;
    try {
      text = await readTeachingResponse(response, MAX_TEACHING_CONFIGURATION_BYTES, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof RangeError)
        throw teachingFailure(readProblem, "The teaching response is too large.");
      throw teachingFailure(readProblem, "The teaching response could not be read.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw teachingFailure(readProblem, "The teaching response is not valid JSON.");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw teachingFailure(readProblem, "The teaching response violates its contract.");
    }
    if (result.data.requestId !== body.requestId) {
      throw teachingFailure(readProblem, "The teaching response does not match its request.");
    }
    const responseClassId = (result.data as { classId?: string }).classId;
    if (responseClassId !== classId) {
      throw teachingFailure(readProblem, "The teaching response belongs to another class.");
    }
    return result.data;
  }

  return Object.freeze<TeachingClient>({
    classes(afterClassId, signal) {
      return post(
        "classes",
        TeachingClassesQuerySchema.parse({
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          requestId: RequestIdSchema.parse(createRequestId()),
          kind: "teaching-classes-query",
          afterClassId,
        }),
        TeachingClassesResponseSchema,
        signal,
        "load",
      );
    },
    read(classId, signal) {
      return post(
        "read",
        TeachingConfigurationQuerySchema.parse({
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          requestId: RequestIdSchema.parse(createRequestId()),
          kind: "teaching-configuration-query",
          classId,
        }),
        TeachingConfigurationResponseSchema,
        signal,
        "load",
        classId,
      );
    },
    catalog(classId, afterSkillId, signal) {
      return post(
        "catalog",
        TeachingCatalogQuerySchema.parse({
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          requestId: RequestIdSchema.parse(createRequestId()),
          kind: "teaching-catalog-query",
          classId,
          afterSkillId,
        }),
        TeachingCatalogResponseSchema,
        signal,
        "load",
        classId,
      );
    },
    save(classId, expectedVersion, settings, signal) {
      return post(
        "save",
        SaveTeachingConfigurationRequestSchema.parse({
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          requestId: RequestIdSchema.parse(createRequestId()),
          kind: "teaching-configuration-save",
          classId,
          expectedVersion,
          settings,
        }),
        SaveTeachingConfigurationResponseSchema,
        signal,
        "uncertain",
        classId,
      );
    },
  });
}

export const localTeachingClient: TeachingClient = createTeachingClient((input, init) =>
  fetch(input, init),
);

function teachingFailure(code: TeachingProblem, message: string): TeachingClientFailure {
  return Object.assign(new Error(message), { code });
}

function responseProblem(status: number): TeachingProblem | null {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 422) return "skill-unavailable";
  if (status === 503) return "unconfigured";
  if (status === 400 || status === 413) return "invalid";
  return null;
}
