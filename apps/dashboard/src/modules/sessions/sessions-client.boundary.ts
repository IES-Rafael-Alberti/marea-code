import { browserRandomUUID } from "../../browser-random-uuid.js";
import { authenticatedJsonRequest } from "../evaluation/authenticated-json.boundary.js";
import {
  createRunClosureClient,
  type RunClosureClient,
} from "../run-closure/run-closure-client.boundary.js";
import { sessionExportClient, type SessionExportClient } from "./export-client.boundary.js";
import {
  ClassSessionsQuerySchema,
  ClassSessionsResponseSchema,
  type ClassSessionsQuery,
  type ClassSessionsResponse,
} from "@marea/protocol";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import {
  createEvaluationClient,
  type EvaluationClient,
} from "../evaluation/evaluation-client.boundary.js";
/** Server-side listing filters; an omitted field does not filter. */
export type SessionFilters = Pick<
  ClassSessionsQuery,
  "runState" | "evaluation" | "evidence" | "search"
>;
export interface SessionsClient extends EvaluationClient {
  readonly exports?: SessionExportClient;
  readonly closures?: RunClosureClient;
  subscribe?(changed: () => void): () => void;
  classes(
    cursor: string | null,
    signal: AbortSignal,
    classId?: string,
    filters?: SessionFilters,
  ): Promise<ClassSessionsResponse>;
}
export function createSessionsClient(fetchRequest: DashboardFetch): SessionsClient {
  return {
    exports: sessionExportClient(fetchRequest),
    closures: createRunClosureClient(fetchRequest),
    ...createEvaluationClient(fetchRequest),
    async classes(cursor, signal, classId, filters = {}) {
      const body = ClassSessionsQuerySchema.parse({
        ...filters,
        includeReview: true,
        kind: "session-history-query",
        protocolVersion: "0.1",
        requestId: `request:${browserRandomUUID()}`,
        limit: 50,
        classId,
        ...(cursor === null ? {} : { beforeRunId: cursor }),
      });
      const response = await authenticatedJsonRequest(
        fetchRequest,
        "/api/v1/dashboard/history/classes",
        body,
        signal,
      );
      const page = ClassSessionsResponseSchema.parse(await response.json());
      if (
        page.requestId !== body.requestId ||
        (page.nextBeforeRunId !== null && page.nextBeforeRunId !== page.runs.at(-1)?.runId) ||
        (classId !== undefined && page.runs.some((run) => run.classId !== classId))
      )
        throw new Error("Class session response mismatch.");
      return page;
    },
  };
}
