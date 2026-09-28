import { Buffer } from "node:buffer";

import { DashboardCursorSchema, RunIdSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import type {
  DashboardPage,
  DashboardRepository,
  DashboardRun,
} from "../../dashboard-api/contracts.js";
import { rowBoolean, rowInteger, rowText } from "./row-parser.boundary.js";
import { activeGovernanceMembership } from "./governance-access-sql.js";

const GOVERNED_ACCESS = activeGovernanceMembership(
  "access.teacher_id",
  "active.class_id",
  "'teacher'",
);

const SELECT_RUNS = `SELECT active.run_id, users.display_name AS student_display_name,
  classes.display_name AS class_display_name, active.project_display_name,
  active.started_at, active.last_activity_at, active.highest_durable_sequence,
  active.pending_approval
  FROM marea_active_runs active
  JOIN marea_users users ON users.id = active.student_id
  JOIN marea_classes classes ON classes.id = active.class_id
  JOIN marea_teacher_classes access ON access.class_id = active.class_id`;

function dashboardRun(row: SqliteRow): DashboardRun {
  return {
    classDisplayName: rowText(row, "class_display_name"),
    highestDurableSequence: rowInteger(row, "highest_durable_sequence"),
    lastActivityAt: rowText(row, "last_activity_at"),
    pendingApproval: rowBoolean(row, "pending_approval"),
    projectDisplayName: rowText(row, "project_display_name"),
    runId: RunIdSchema.parse(rowText(row, "run_id")),
    startedAt: rowText(row, "started_at"),
    state: "active",
    studentDisplayName: rowText(row, "student_display_name"),
  };
}

function cursorFor(runId: string) {
  return DashboardCursorSchema.parse(Buffer.from(runId).toString("base64url"));
}

function cursorRunId(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

export class SqliteDashboardRepository implements DashboardRepository {
  readonly #database: SqliteApplicationDatabase;

  public constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
  }

  public listActiveRuns(input: {
    readonly cursor: string | undefined;
    readonly limit: number;
    readonly teacherId: string;
  }): DashboardPage {
    const rows = this.readPage(input);
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      nextCursor:
        rows.length > input.limit &&
        // Stryker disable next-line ConditionalExpression: A validated positive limit makes last defined when another row exists.
        last !== undefined
          ? cursorFor(rowText(last, "run_id"))
          : null,
      runs: pageRows.map(dashboardRun),
    };
  }

  private readPage(input: {
    readonly cursor: string | undefined;
    readonly limit: number;
    readonly teacherId: string;
  }): readonly SqliteRow[] {
    if (input.cursor === undefined) {
      return this.#database.readAll(
        `${SELECT_RUNS} WHERE access.teacher_id = ?1 AND ${GOVERNED_ACCESS}
          ORDER BY active.last_activity_at DESC, active.run_id DESC LIMIT ?2`,
        [input.teacherId, input.limit + 1],
      );
    }
    const anchor = this.#database.readOne(
      `SELECT active.last_activity_at, active.run_id FROM marea_active_runs active
        JOIN marea_teacher_classes access ON access.class_id = active.class_id
        WHERE access.teacher_id = ?1 AND active.run_id = ?2 AND ${GOVERNED_ACCESS}`,
      [input.teacherId, cursorRunId(input.cursor)],
    );
    if (anchor === undefined) {
      return [];
    }
    const activity = rowText(anchor, "last_activity_at");
    const runId = rowText(anchor, "run_id");
    return this.#database.readAll(
      `${SELECT_RUNS} WHERE access.teacher_id = ?1 AND ${GOVERNED_ACCESS}
        AND (active.last_activity_at < ?2
          OR (active.last_activity_at = ?2 AND active.run_id < ?3))
        ORDER BY active.last_activity_at DESC, active.run_id DESC LIMIT ?4`,
      [input.teacherId, activity, runId, input.limit + 1],
    );
  }
}
