import {
  MAX_USAGE_HEALTH_RESPONSE_BYTES,
  TEACHER_HEALTH_PATH,
  TeacherHealthRequestSchema,
  TeacherHealthResponseSchema,
  USAGE_QUERY_PATH,
  UsageQuerySchema,
  UsageResponseSchema,
  type UsageHealthPort,
} from "@marea/protocol";
import { readBoundedJson } from "../bounded-json.boundary.js";
import { dashboardPost } from "../dashboard-post.js";
import type { DashboardFetch } from "./active-runs/active-runs-client.boundary.js";

/** Carries only the HTTP status; error bodies are never read or shown. */
export class UsageHealthRequestError extends Error {
  constructor(readonly status: number) {
    super("Class projection unavailable.");
  }
}

interface Scoped {
  readonly requestId: string;
  readonly classId: string;
}

/** Cookie-authenticated projection reads; late or foreign responses never reach a caller. */
export function createProjectionPost(fetchRequest: DashboardFetch, maximumBytes: number) {
  return async function post<Result extends Scoped>(
    path: string,
    body: Scoped,
    schema: { parse(value: unknown): Result },
    signal: AbortSignal,
  ): Promise<Result> {
    const response = await fetchRequest(path, dashboardPost(body, signal));
    if (!response.ok) throw new UsageHealthRequestError(response.status);
    if (response.body === null) throw new Error("Missing class projection.");
    const result = schema.parse(await readBoundedJson(response.body, maximumBytes));
    if (result.requestId !== body.requestId || result.classId !== body.classId)
      throw new Error("Class projection mismatch.");
    return result;
  };
}

export function createUsageHealthClient(fetchRequest: DashboardFetch): UsageHealthPort {
  const post = createProjectionPost(fetchRequest, MAX_USAGE_HEALTH_RESPONSE_BYTES);
  return {
    async queryUsage(request, signal) {
      const body = UsageQuerySchema.parse(request);
      const result = await post(USAGE_QUERY_PATH, body, UsageResponseSchema, signal);
      if (result.from !== body.from || result.until !== body.until)
        throw new Error("Class projection mismatch.");
      return result;
    },
    async readHealth(request, signal) {
      const body = TeacherHealthRequestSchema.parse(request);
      return post(TEACHER_HEALTH_PATH, body, TeacherHealthResponseSchema, signal);
    },
  };
}
