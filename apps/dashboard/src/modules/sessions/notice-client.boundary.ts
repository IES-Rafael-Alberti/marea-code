import {
  PublishTeacherNoticeRequestSchema,
  PublishTeacherNoticeResponseSchema,
  TeacherNoticeQuerySchema,
  TeacherNoticeQueryResponseSchema,
  type TeacherNoticeQueryResponse,
  type PublishTeacherNoticeResponse,
} from "@marea/protocol";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";

export interface NoticeClient {
  publish(
    runId: string,
    text: string,
    key: string,
    signal: AbortSignal,
  ): Promise<PublishTeacherNoticeResponse>;
  query(runId: string, key: string, signal: AbortSignal): Promise<TeacherNoticeQueryResponse>;
}
export function createNoticeClient(fetchRequest: DashboardFetch): NoticeClient {
  const envelope = () => ({ protocolVersion: "0.1", requestId: `request:${crypto.randomUUID()}` });
  async function post<T extends { requestId: string }>(
    path: string,
    body: { requestId: string },
    schema: { parse(value: unknown): T },
    signal: AbortSignal,
  ) {
    const response = await fetchRequest(`/api/v1/dashboard/notices/${path}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Notice request failed.");
    const result = schema.parse(await response.json());
    if (result.requestId !== body.requestId) throw new Error("Notice correlation failed.");
    return result;
  }
  return {
    async publish(runId, text, key, signal) {
      const body = PublishTeacherNoticeRequestSchema.parse({
        ...envelope(),
        kind: "teacher-notice-publish",
        runId,
        text,
        idempotencyKey: key,
      });
      const result = await post("publish", body, PublishTeacherNoticeResponseSchema, signal);
      if (result.notice.runId !== runId || result.notice.text !== body.text)
        throw new Error("Notice publication mismatch.");
      return result;
    },
    async query(runId, key, signal) {
      const body = TeacherNoticeQuerySchema.parse({
        ...envelope(),
        kind: "teacher-notice-query",
        runId,
        idempotencyKey: key,
      });
      const result = await post("query", body, TeacherNoticeQueryResponseSchema, signal);
      if (
        result.runId !== runId ||
        result.idempotencyKey !== key ||
        (result.publication !== null && result.publication.notice.runId !== runId)
      )
        throw new Error("Notice lookup mismatch.");
      return result;
    },
  };
}
