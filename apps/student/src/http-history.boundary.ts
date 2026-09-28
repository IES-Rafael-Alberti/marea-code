import {
  AcknowledgeNoticeRequestSchema,
  AcknowledgeNoticeResponseSchema,
  PendingNoticesRequestSchema,
  PendingNoticesResponseSchema,
  RunHistoryQuerySchema,
  RunHistoryResponseSchema,
  SessionHistoryQuerySchema,
  SessionHistoryResponseSchema,
  type AcknowledgeNoticeRequest,
  type AcknowledgeNoticeResponse,
  type PendingNoticesRequest,
  type PendingNoticesResponse,
  type RunHistoryQuery,
  type RunHistoryResponse,
  type SessionHistoryQuery,
  type SessionHistoryResponse,
  type SessionToken,
} from "@marea/protocol";

import { createHttpClient, type StudentHttpOptions } from "./http-client.boundary.js";

export interface StudentHistoryServer {
  readRun(token: SessionToken, query: RunHistoryQuery): Promise<RunHistoryResponse>;
  listSessions(token: SessionToken, query: SessionHistoryQuery): Promise<SessionHistoryResponse>;
  pendingNotices(
    token: SessionToken,
    query: PendingNoticesRequest,
  ): Promise<PendingNoticesResponse>;
  acknowledgeNotice(
    token: SessionToken,
    request: AcknowledgeNoticeRequest,
  ): Promise<AcknowledgeNoticeResponse>;
}

export function createHttpStudentHistory(options: StudentHttpOptions): StudentHistoryServer {
  const client = createHttpClient(options);
  return Object.freeze({
    readRun(token: SessionToken, query: RunHistoryQuery) {
      const validated = RunHistoryQuerySchema.parse(query);
      return client.json(
        "/v1/history/run",
        validated.requestId,
        validated,
        RunHistoryResponseSchema.refine(
          (page) =>
            page.runId === validated.runId &&
            page.afterSequence === validated.afterSequence &&
            (validated.throughSequence === undefined ||
              page.throughSequence === validated.throughSequence) &&
            page.events.length <= validated.limit,
        ),
        token,
        16 * 1_048_576,
      );
    },
    listSessions(token: SessionToken, query: SessionHistoryQuery) {
      const validated = SessionHistoryQuerySchema.parse(query);
      return client.json(
        "/v1/history/sessions",
        validated.requestId,
        validated,
        SessionHistoryResponseSchema.refine(
          (page) =>
            page.runs.length <= validated.limit &&
            // The only mutant here removes optional chaining. With no runs and
            // a non-null cursor, that mutant throws and HttpClient.json still
            // reports the same "response.invalid" as this comparison, so the
            // mutation is behaviorally equivalent and cannot fail any test.
            // Stryker disable next-line OptionalChaining
            (page.nextBeforeRunId === null || page.nextBeforeRunId === page.runs.at(-1)?.runId),
        ),
        token,
      );
    },
    pendingNotices(token: SessionToken, query: PendingNoticesRequest) {
      const validated = PendingNoticesRequestSchema.parse(query);
      return client.json(
        "/v1/notices/pending",
        validated.requestId,
        validated,
        PendingNoticesResponseSchema.refine((page) => page.notices.length <= validated.limit),
        token,
        4 * 1_048_576,
      );
    },
    acknowledgeNotice(token: SessionToken, request: AcknowledgeNoticeRequest) {
      const validated = AcknowledgeNoticeRequestSchema.parse(request);
      return client.json(
        "/v1/notices/acknowledge",
        validated.requestId,
        validated,
        AcknowledgeNoticeResponseSchema.refine(
          (receipt) => receipt.noticeId === validated.noticeId,
        ),
        token,
      );
    },
  });
}
