import {
  ClassSessionsResponseSchema,
  type ClassSessionsResponse,
  type CanonicalRunEvent,
  CURRENT_PROTOCOL_VERSION,
  RunHistoryResponseSchema,
  SessionHistoryResponseSchema,
  type RunHistoryQuery,
  type RunHistoryResponse,
  type SessionHistoryQuery,
  type SessionHistoryResponse,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../identity/contracts.js";

export type RunHistoryPage = Omit<RunHistoryResponse, "kind" | "protocolVersion" | "requestId">;
export type SessionHistoryPage = Pick<ClassSessionsResponse, "runs" | "nextBeforeRunId">;

export interface HistoryRepository {
  readRun(identity: AuthenticatedIdentity, query: RunHistoryQuery): RunHistoryPage;
  listSessions(identity: AuthenticatedIdentity, query: SessionHistoryQuery): SessionHistoryPage;
}

function studentHistoryEvent(event: CanonicalRunEvent): CanonicalRunEvent {
  if (
    event.eventType !== "tool-started" &&
    event.eventType !== "tool-finished" &&
    event.eventType !== "model-diagnostic"
  )
    return event;
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    eventType: "internal-activity",
  };
}

export class HistoryService {
  readonly #repository: HistoryRepository;

  public constructor(repository: HistoryRepository) {
    this.#repository = repository;
  }

  public readRun(identity: AuthenticatedIdentity, query: RunHistoryQuery): RunHistoryResponse {
    const page = this.#repository.readRun(identity, query);
    return RunHistoryResponseSchema.parse({
      ...page,
      events: identity.role === "student" ? page.events.map(studentHistoryEvent) : page.events,
      kind: "run-history-response",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: query.requestId,
    });
  }

  public listSessions(
    identity: AuthenticatedIdentity,
    query: SessionHistoryQuery,
  ): SessionHistoryResponse {
    const page = this.#repository.listSessions(identity, query);
    return SessionHistoryResponseSchema.parse({
      ...page,
      runs: page.runs.map((run) => ({
        runId: run.runId,
        studentDisplayName: run.studentDisplayName,
        classDisplayName: run.classDisplayName,
        projectDisplayName: run.projectDisplayName,
        state: run.state,
        openedAt: run.openedAt,
        closedAt: run.closedAt,
      })),
      kind: "session-history-response",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: query.requestId,
    });
  }
  public listClassSessions(
    identity: AuthenticatedIdentity,
    query: SessionHistoryQuery,
  ): ClassSessionsResponse {
    return ClassSessionsResponseSchema.parse({
      ...this.#repository.listSessions(identity, query),
      kind: "class-sessions-response",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: query.requestId,
    });
  }
}
