import { browserRandomUUID } from "../../browser-random-uuid.js";
import { dashboardPost } from "../../dashboard-post.js";
import {
  ApproveEvaluationRequestSchema,
  EvaluationQuerySchema,
  EvaluationResponseSchema,
  GenerateEvaluationRequestSchema,
  RunHistoryQuerySchema,
  RunHistoryResponseSchema,
  SessionHistoryQuerySchema,
  SessionHistoryResponseSchema,
  type EvaluationDraft,
  type EvaluationResponse,
  type RunHistoryResponse,
  type SessionHistoryResponse,
} from "@marea/protocol";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";

export class EvaluationRequestError extends Error {
  constructor(readonly status: number) {
    super("The evaluation request failed. Refresh to check its current state.");
  }
}

export interface EvaluationClient {
  sessions(beforeRunId: string | null, signal: AbortSignal): Promise<SessionHistoryResponse>;
  history(
    runId: string,
    afterSequence: number,
    throughSequence: number | undefined,
    signal: AbortSignal,
  ): Promise<RunHistoryResponse>;
  query(runId: string, signal: AbortSignal): Promise<EvaluationResponse>;
  generate(
    runId: string,
    expectedEvaluationId: string | null,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<EvaluationResponse>;
  approve(
    runId: string,
    evaluationId: string,
    draft: EvaluationDraft,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<EvaluationResponse>;
}

export function createEvaluationClient(
  fetchRequest: DashboardFetch,
  createId: () => string = () => `request:${browserRandomUUID()}`,
): EvaluationClient {
  const envelope = () => ({ protocolVersion: "0.1", requestId: createId() });
  async function post<T extends { readonly requestId: string }>(
    path: string,
    body: { readonly requestId: string },
    schema: { parse(input: unknown): T },
    signal: AbortSignal,
  ): Promise<T> {
    const response = await fetchRequest(`/api/v1/dashboard/${path}`, dashboardPost(body, signal));
    if (!response.ok) throw new EvaluationRequestError(response.status);
    const parsed = schema.parse(await response.json());
    if (parsed.requestId !== body.requestId)
      throw new Error("The evaluation response does not match its request.");
    return parsed;
  }
  return Object.freeze<EvaluationClient>({
    async sessions(beforeRunId, signal) {
      const body = SessionHistoryQuerySchema.parse({
        ...envelope(),
        kind: "session-history-query",
        limit: 50,
        ...(beforeRunId === null ? {} : { beforeRunId }),
      });
      const page = await post("history/sessions", body, SessionHistoryResponseSchema, signal);
      if (page.nextBeforeRunId !== null && page.nextBeforeRunId !== page.runs.at(-1)?.runId)
        throw new Error("The session cursor does not match its page.");
      return page;
    },
    async history(runId, afterSequence, throughSequence, signal) {
      const body = RunHistoryQuerySchema.parse({
        ...envelope(),
        kind: "run-history-query",
        runId,
        afterSequence,
        throughSequence,
        limit: 32,
      });
      const page = await post("history/run", body, RunHistoryResponseSchema, signal);
      if (
        page.runId !== runId ||
        page.afterSequence !== afterSequence ||
        (throughSequence !== undefined && page.throughSequence !== throughSequence)
      )
        throw new Error("The history response does not match its request.");
      return page;
    },
    async query(runId, signal) {
      const body = EvaluationQuerySchema.parse({ ...envelope(), kind: "evaluation-query", runId });
      return matchRun(
        await post("evaluations/query", body, EvaluationResponseSchema, signal),
        runId,
      );
    },
    async generate(runId, expectedEvaluationId, idempotencyKey, signal) {
      const body = GenerateEvaluationRequestSchema.parse({
        ...envelope(),
        kind: "evaluation-generate",
        runId,
        expectedEvaluationId,
        idempotencyKey,
      });
      const response = matchRun(
        await post("evaluations/generate", body, EvaluationResponseSchema, signal),
        runId,
      );
      if (response.evaluation === null) throw new Error("The generated evaluation is missing.");
      return response;
    },
    async approve(runId, evaluationId, draft, idempotencyKey, signal) {
      const body = ApproveEvaluationRequestSchema.parse({
        ...envelope(),
        kind: "evaluation-approve-send",
        runId,
        evaluationId,
        draft,
        idempotencyKey,
      });
      const response = matchRun(
        await post("evaluations/approve", body, EvaluationResponseSchema, signal),
        runId,
      );
      if (
        response.evaluation?.state !== "approved" ||
        response.evaluation.evaluationId !== evaluationId
      )
        throw new Error("The approval response does not confirm the reviewed evaluation.");
      return response;
    },
  });
}

function matchRun(response: EvaluationResponse, runId: string): EvaluationResponse {
  if (response.evaluation !== null && response.evaluation.runId !== runId)
    throw new Error("The evaluation belongs to a different run.");
  return response;
}
