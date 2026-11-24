import {
  ClassRunsCloseRequestSchema,
  RunsCloseResponseSchema,
  TeacherRunCloseRequestSchema,
  type RunsCloseResponse,
} from "@marea/protocol";

import { browserRandomUUID } from "../../browser-random-uuid.js";
import { dashboardPost } from "../../dashboard-post.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";

/** Why the server did not end the sessions, so the teacher sees what to do next. */
export type RunClosureFailure =
  | { readonly kind: "offline" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "expired" }
  | { readonly kind: "server"; readonly requestId: string }
  | { readonly kind: "invalid" };

export class RunClosureError extends Error {
  constructor(readonly failure: RunClosureFailure = { kind: "invalid" }) {
    super("The sessions could not be ended. Refresh to check their current state.");
  }
}

async function errorRequestId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const requestId =
      typeof body === "object" && body !== null && "requestId" in body ? body.requestId : null;
    return typeof requestId === "string" ? requestId : null;
  } catch {
    return null;
  }
}

async function failureOf(response: Response, sentRequestId: string): Promise<RunClosureFailure> {
  if (response.status === 401) return { kind: "expired" };
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 409) return { kind: "unavailable" };
  if (response.status >= 500)
    return { kind: "server", requestId: (await errorRequestId(response)) ?? sentRequestId };
  return { kind: "invalid" };
}

export interface RunClosureClient {
  closeRun(runId: string, idempotencyKey: string, signal: AbortSignal): Promise<RunsCloseResponse>;
  closeClassRuns(
    classId: string,
    runIds: readonly string[],
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<RunsCloseResponse>;
}

export function createRunClosureClient(
  fetchRequest: DashboardFetch,
  createRequestId: () => string = () => `request:${browserRandomUUID()}`,
): RunClosureClient {
  async function post(
    path: string,
    body: { readonly requestId: string },
    runIds: readonly string[],
    signal: AbortSignal,
  ): Promise<RunsCloseResponse> {
    let response: Response;
    try {
      response = await fetchRequest(path, dashboardPost(body, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RunClosureError({ kind: "offline" });
    }
    if (!response.ok) throw new RunClosureError(await failureOf(response, body.requestId));
    const result = RunsCloseResponseSchema.parse(await response.json());
    // A response must account for exactly the runs that were asked about.
    const asked = new Set(runIds);
    const reported = [...result.closed, ...result.unchanged];
    if (
      result.requestId !== body.requestId ||
      new Set(reported).size !== reported.length ||
      reported.length !== asked.size ||
      reported.some((runId) => !asked.has(runId))
    )
      throw new RunClosureError();
    return result;
  }
  return {
    closeRun(runId, idempotencyKey, signal) {
      const body = TeacherRunCloseRequestSchema.parse({
        kind: "teacher-run-close",
        protocolVersion: "0.1",
        requestId: createRequestId(),
        runId,
        idempotencyKey,
      });
      return post("/api/v1/dashboard/runs/close", body, [runId], signal);
    },
    closeClassRuns(classId, runIds, idempotencyKey, signal) {
      const body = ClassRunsCloseRequestSchema.parse({
        kind: "class-runs-close",
        protocolVersion: "0.1",
        requestId: createRequestId(),
        classId,
        runIds,
        idempotencyKey,
      });
      return post("/api/v1/dashboard/classes/close-runs", body, runIds, signal);
    },
  };
}
