import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { TeacherDomainError } from "../../identity/errors.js";
import type {
  CloseAbandonedRunsInput,
  CloseTeacherRunsInput,
  CloseTeacherRunsResult,
  RunClosureRepository,
} from "../../sessions/run-closure-contracts.js";
import { activeGovernanceMembership } from "./governance-access-sql.js";
import { rowText } from "./row-parser.boundary.js";
import { closeActiveRun } from "./sqlite-run-closing.js";
import { SqliteTeachingConfigurationRepository } from "./sqlite-teaching-configuration-repository.js";

/** Every condition is rechecked per run inside its closing transaction. */
const ABANDONED = `runs.state = 'active'
  AND NOT EXISTS (SELECT 1 FROM marea_run_leases leases
    WHERE leases.run_id = runs.id AND leases.revoked_at IS NULL AND leases.expires_at > ?1)
  AND (active.last_activity_at < ?2
    OR (runs.opened_at <= ?3 AND NOT EXISTS (SELECT 1 FROM marea_auth_sessions sessions
      WHERE sessions.user_id = runs.student_id AND sessions.revoked_at IS NULL
        AND sessions.expires_at > ?1)))`;

const ABANDONED_RUNS = `SELECT runs.id FROM marea_runs runs
  JOIN marea_active_runs active ON active.run_id = runs.id`;

const TEACHER_RUN = `SELECT runs.id, runs.state FROM marea_runs runs
  JOIN marea_teacher_classes access ON access.class_id = runs.class_id
  WHERE runs.id = ?1 AND access.teacher_id = ?2
    AND ${activeGovernanceMembership("?2", "runs.class_id", "'teacher'")}`;

export class SqliteRunClosureRepository implements RunClosureRepository {
  readonly #database: SqliteApplicationDatabase;
  readonly #classes: Pick<SqliteTeachingConfigurationRepository, "requireTeacherClass">;

  public constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
    this.#classes = new SqliteTeachingConfigurationRepository(database);
  }

  public closeAbandoned(input: CloseAbandonedRunsInput): number {
    const candidates = this.#database.readAll(
      `${ABANDONED_RUNS} WHERE ${ABANDONED} ORDER BY active.last_activity_at, runs.id LIMIT 500`,
      [input.now, input.idleBefore, input.sessionOpenedBefore],
    );
    let closed = 0;
    for (const candidate of candidates) {
      const runId = rowText(candidate, "id");
      closed += this.#database.transaction(() => {
        // A student who reconnected since the scan is no longer abandoned.
        const stillAbandoned = this.#database.readOne(
          `${ABANDONED_RUNS} WHERE ${ABANDONED} AND runs.id = ?4`,
          [input.now, input.idleBefore, input.sessionOpenedBefore, runId],
        );
        if (stillAbandoned === undefined) return 0;
        closeActiveRun(this.#database, runId, {
          closedAt: input.now,
          closingEventId: input.createEventId(),
          reason: "session-expired",
        });
        return 1;
      });
    }
    return closed;
  }

  public closeRuns(input: CloseTeacherRunsInput): CloseTeacherRunsResult {
    return this.#database.transaction(() => {
      if (input.classId !== null) this.#classes.requireTeacherClass(input.teacherId, input.classId);
      const closed: string[] = [];
      const unchanged: string[] = [];
      for (const runId of input.runIds) {
        const run = this.#database.readOne(
          `${TEACHER_RUN}${input.classId === null ? "" : " AND runs.class_id = ?3"}`,
          input.classId === null
            ? [runId, input.teacherId]
            : [runId, input.teacherId, input.classId],
        );
        // A listed run of another class never reveals whether it exists.
        if (run === undefined && input.classId === null) {
          throw new TeacherDomainError("run.unavailable");
        }
        if (run === undefined || rowText(run, "state") !== "active") {
          unchanged.push(runId);
          continue;
        }
        closeActiveRun(this.#database, runId, {
          closedAt: input.closedAt,
          closingEventId: input.createEventId(),
          reason: input.reason,
          closedBy: input.teacherId,
        });
        closed.push(runId);
      }
      return { closed, unchanged };
    });
  }
}
