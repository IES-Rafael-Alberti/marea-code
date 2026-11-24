import {
  ClassRunsCloseRequestSchema,
  CURRENT_PROTOCOL_VERSION,
  RunsCloseResponseSchema,
  TeacherRunCloseRequestSchema,
  type ClassRunsCloseRequest,
  type RunsCloseResponse,
  type TeacherRunCloseRequest,
} from "@marea/protocol";

import type { AuthenticatedIdentity, Clock, IdGenerator } from "../identity/contracts.js";
import { SESSION_MAX_LIFETIME_SECONDS } from "../identity/identity-service.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { CloseTeacherRunsResult, RunClosureRepository } from "./run-closure-contracts.js";

/** A run with no presence, lease renewal or event for this long is considered abandoned. */
export const ABANDONED_RUN_IDLE_MS = 60 * 60 * 1_000;

export interface RunClosureServiceOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly repository: RunClosureRepository;
}

function requireTeacher(identity: AuthenticatedIdentity): string {
  if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
  return identity.userId;
}

export class RunClosureService {
  readonly #options: RunClosureServiceOptions;

  public constructor(options: RunClosureServiceOptions) {
    this.#options = options;
  }

  /** Closes runs that lost their connection or outlived the student's sign-in session cap. */
  public closeAbandoned(): number {
    const now = this.#options.clock.now();
    return this.#options.repository.closeAbandoned({
      createEventId: () => this.#options.ids.createId("event"),
      idleBefore: new Date(Date.parse(now) - ABANDONED_RUN_IDLE_MS).toISOString(),
      now,
      sessionOpenedBefore: new Date(
        Date.parse(now) - SESSION_MAX_LIFETIME_SECONDS * 1_000,
      ).toISOString(),
    });
  }

  public closeRun(identity: AuthenticatedIdentity, request: TeacherRunCloseRequest) {
    const parsed = TeacherRunCloseRequestSchema.parse(request);
    return this.respond(
      parsed.requestId,
      this.#options.repository.closeRuns({
        classId: null,
        closedAt: this.#options.clock.now(),
        createEventId: () => this.#options.ids.createId("event"),
        reason: "teacher-ended",
        runIds: [parsed.runId],
        teacherId: requireTeacher(identity),
      }),
    );
  }

  public closeClassRuns(identity: AuthenticatedIdentity, request: ClassRunsCloseRequest) {
    const parsed = ClassRunsCloseRequestSchema.parse(request);
    return this.respond(
      parsed.requestId,
      this.#options.repository.closeRuns({
        classId: parsed.classId,
        closedAt: this.#options.clock.now(),
        createEventId: () => this.#options.ids.createId("event"),
        reason: "class-ended",
        runIds: parsed.runIds,
        teacherId: requireTeacher(identity),
      }),
    );
  }

  private respond(requestId: string, result: CloseTeacherRunsResult): RunsCloseResponse {
    return RunsCloseResponseSchema.parse({
      closed: result.closed,
      kind: "runs-close-response",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId,
      unchanged: result.unchanged,
    });
  }
}
