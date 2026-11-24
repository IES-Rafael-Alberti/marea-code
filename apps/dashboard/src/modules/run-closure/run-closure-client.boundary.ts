import {
  ClassRunsCloseRequestSchema,
  RunsCloseResponseSchema,
  TeacherRunCloseRequestSchema,
  type RunsCloseResponse,
} from "@marea/protocol";

import { browserRandomUUID } from "../../browser-random-uuid.js";
import { dashboardPost } from "../../dashboard-post.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";

export class RunClosureError extends Error {
  constructor() {
    super("The sessions could not be ended. Refresh to check their current state.");
  }
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
    const response = await fetchRequest(path, dashboardPost(body, signal));
    if (!response.ok) throw new RunClosureError();
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
