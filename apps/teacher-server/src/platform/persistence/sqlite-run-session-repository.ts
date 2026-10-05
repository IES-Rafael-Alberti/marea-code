import { CanonicalRunEventSchema, StudentRunSnapshotSchema } from "@marea/protocol";
import type { CanonicalRunEvent, StudentRunSnapshot } from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import { TeacherDomainError } from "../../identity/errors.js";
import { TeachingSnapshotContentSchema } from "../../teaching/configuration/configuration-schema.js";
import type {
  AppendEventsInput,
  AuthorizedRunLease,
  AuthorizeRunLeaseInput,
  CloseAuthenticatedRunInput,
  CloseStoredRunInput,
  CloseStoredRunResult,
  OpenStoredRunInput,
  OpenStoredRunResult,
  RunSessionRepository,
  RenewStoredLeaseInput,
  RenewStoredLeaseResult,
} from "../../sessions/contracts.js";
import { rowInteger, rowJson, rowText } from "./row-parser.boundary.js";
import { activeGovernanceMembership, activeStudentClass } from "./governance-access-sql.js";
import { loadRunStartup, validateStartupEvent } from "./sqlite-run-startup.js";
import { PrivateProviderRouteSchema as StoredProviderRouteSchema } from "../../model-gateway/route-policy.js";

interface StoredRun {
  readonly runId: string;
  readonly snapshot: StudentRunSnapshot;
  readonly state: string;
}

function unavailable(): never {
  throw new TeacherDomainError("run.unavailable");
}

function requestConflict(): never {
  throw new TeacherDomainError("request.conflict");
}

function eventJson(event: CanonicalRunEvent): string {
  return JSON.stringify(event);
}

function pendingAfter(current: boolean, event: CanonicalRunEvent): boolean {
  if (event.eventType === "approval-requested") {
    return true;
  }
  if (event.eventType === "approval-resolved") {
    return false;
  }
  return current;
}

export class SqliteRunSessionRepository implements RunSessionRepository {
  readonly #database: SqliteApplicationDatabase;

  public constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
  }

  public openRun(input: OpenStoredRunInput): OpenStoredRunResult {
    return this.#database.transaction(() => {
      const denied = this.#database.readAll(
        `SELECT 1 AS denied WHERE NOT EXISTS (SELECT 1 FROM marea_users users
          WHERE users.id = ?1 AND users.role = 'student' AND ?2 IS NOT NULL
            AND ${activeStudentClass("users.id", "?2")})`,
        [input.student.userId, input.student.classId],
      );
      if (denied.length !== 0) unavailable();
      const previous = this.#database.readOne(
        `SELECT fingerprint, run_id FROM marea_run_open_requests
          WHERE student_id = ?1 AND idempotency_key = ?2`,
        [input.student.userId, input.idempotencyKey],
      );
      const stored =
        previous === undefined
          ? this.selectOrCreateRun(input)
          : this.loadIdempotent(previous, input);
      if (stored.state !== "active") {
        unavailable();
      }
      const highestDurableSequence = rowInteger(
        this.requiredProjection(stored.runId),
        "highest_durable_sequence",
      );
      this.rotateLease(stored.runId, input);
      const startupState = loadRunStartup(this.#database, stored.runId, stored.snapshot);
      return {
        highestDurableSequence,
        runId: stored.runId,
        snapshot: stored.snapshot,
        ...(startupState === undefined ? {} : { startupState }),
      };
    });
  }

  public appendEvents(input: AppendEventsInput): number {
    return this.#database.transaction(() => {
      const { runId } = this.authorizeLease({
        leaseTokenHash: input.leaseTokenHash,
        now: input.now,
      });
      const projection = this.requiredProjection(runId);
      let highest = rowInteger(projection, "highest_durable_sequence");
      let lastActivity = rowText(projection, "last_activity_at");
      let pending = rowInteger(projection, "pending_approval") === 1;
      for (const event of input.events) {
        const inserted = this.appendEvent(runId, event, highest);
        if (inserted) {
          highest = event.sequence;
          // Stryker disable next-line EqualityOperator: Equal timestamps select the same immutable string.
          lastActivity = event.occurredAt > lastActivity ? event.occurredAt : lastActivity;
          pending = pendingAfter(pending, event);
        }
      }
      this.#database.execute(
        `UPDATE marea_active_runs SET last_activity_at = ?2,
          highest_durable_sequence = ?3, pending_approval = ?4 WHERE run_id = ?1`,
        [runId, lastActivity, highest, pending],
      );
      return highest;
    });
  }

  public authorizeLease(input: AuthorizeRunLeaseInput): AuthorizedRunLease {
    const lease = this.#database.readOne(
      `SELECT runs.id AS run_id, runs.student_id, snapshots.provider_route_json
        FROM marea_run_leases leases
        JOIN marea_runs runs ON runs.id = leases.run_id
        JOIN marea_run_snapshots snapshots ON snapshots.id = runs.snapshot_id
        WHERE leases.token_hash = ?1 AND leases.revoked_at IS NULL
          AND leases.expires_at > ?2 AND runs.state = 'active'
          AND ${activeGovernanceMembership("runs.student_id", "runs.class_id", "'student'")}`,
      [input.leaseTokenHash, input.now],
    );
    if (lease === undefined) {
      unavailable();
    }
    return {
      providerRoute: rowJson(lease, "provider_route_json", StoredProviderRouteSchema),
      runId: rowText(lease, "run_id"),
      studentId: rowText(lease, "student_id"),
    };
  }

  public closeRun(input: CloseStoredRunInput): CloseStoredRunResult {
    return this.#database.transaction(() => {
      const run = this.#database.readOne(
        `SELECT runs.id AS run_id, runs.state FROM marea_run_leases leases
          JOIN marea_runs runs ON runs.id = leases.run_id WHERE leases.token_hash = ?1`,
        [input.leaseTokenHash],
      );
      if (run === undefined) {
        unavailable();
      }
      const runId = rowText(run, "run_id");
      if (rowText(run, "state") === "closed") {
        return { alreadyClosed: true, runId };
      }
      if (
        this.authorizeLease({ leaseTokenHash: input.leaseTokenHash, now: input.closedAt }).runId !==
        runId
      ) {
        unavailable();
      }
      return this.closeActiveRun(runId, input);
    });
  }

  public closeRunAuthenticated(input: CloseAuthenticatedRunInput): CloseStoredRunResult {
    return this.#database.transaction(() => {
      const run = this.#database.readOne(
        `SELECT id AS run_id, state FROM marea_runs
          WHERE id = ?1 AND student_id = ?2 AND class_id = ?3
            AND ${activeGovernanceMembership("student_id", "marea_runs.class_id", "'student'")}`,
        [input.runId, input.studentId, input.classId],
      );
      if (run === undefined) unavailable();
      const runId = rowText(run, "run_id");
      if (rowText(run, "state") === "closed") return { alreadyClosed: true, runId };
      return this.closeActiveRun(runId, input);
    });
  }

  public renewLease(input: RenewStoredLeaseInput): RenewStoredLeaseResult {
    return this.#database.transaction(() => {
      const run = this.#database.readOne(
        `SELECT id, state FROM marea_runs
          WHERE id = ?1 AND student_id = ?2 AND class_id = ?3
            AND ${activeGovernanceMembership("student_id", "marea_runs.class_id", "'student'")}`,
        [input.runId, input.studentId, input.classId],
      );
      if (run === undefined || rowText(run, "state") !== "active") unavailable();
      this.#database.execute(
        "UPDATE marea_run_leases SET revoked_at = ?2 WHERE run_id = ?1 AND revoked_at IS NULL",
        [input.runId, input.issuedAt],
      );
      this.#database.execute(
        `INSERT INTO marea_run_leases
          (id, run_id, student_id, token_hash, issued_at, expires_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        [
          input.leaseId,
          input.runId,
          input.studentId,
          input.leaseTokenHash,
          input.issuedAt,
          input.expiresAt,
        ],
      );
      return {
        expiresAt: input.expiresAt,
        issuedAt: input.issuedAt,
        runId: input.runId,
      };
    });
  }

  private selectOrCreateRun(input: OpenStoredRunInput): StoredRun {
    if (input.intent.kind === "resume") {
      const resumable =
        input.resumeRunId === undefined
          ? this.#database.readOne(
              `SELECT id FROM marea_runs WHERE student_id = ?1 AND project_display_name = ?2
                AND class_id = ?3 AND state = 'active' ORDER BY opened_at DESC, id DESC LIMIT 1`,
              [input.student.userId, input.projectDisplayName, input.student.classId],
            )
          : this.#database.readOne(
              `SELECT id FROM marea_runs WHERE id = ?1 AND student_id = ?2
                AND project_display_name = ?3 AND class_id = ?4 AND state = 'active'`,
              [
                input.resumeRunId,
                input.student.userId,
                input.projectDisplayName,
                input.student.classId,
              ],
            );
      if (resumable === undefined) {
        unavailable();
      }
      const stored = this.loadRun(rowText(resumable, "id"), input.student.userId);
      this.rememberOpen(input, stored.runId);
      return stored;
    }
    const snapshot = this.insertRun(input);
    this.rememberOpen(input, input.proposedRunId);
    return {
      runId: input.proposedRunId,
      snapshot,
      state: "active",
    };
  }

  private insertRun(input: OpenStoredRunInput): StudentRunSnapshot {
    const classId = input.student.classId;
    if (classId === null) {
      unavailable();
    }
    const capture = input.captureSnapshot();
    const snapshot = StudentRunSnapshotSchema.parse(capture.snapshot);
    const providerRoute = StoredProviderRouteSchema.parse(capture.providerRoute);
    const teaching =
      capture.teaching === undefined
        ? undefined
        : TeachingSnapshotContentSchema.parse(capture.teaching);
    this.#database.execute(
      `INSERT INTO marea_run_snapshots
        (id, public_snapshot_json, provider_route_json, created_at) VALUES (?1, ?2, ?3, ?4)`,
      [snapshot.id, JSON.stringify(snapshot), JSON.stringify(providerRoute), input.openedAt],
    );
    if (teaching !== undefined) {
      this.#database.execute(
        "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES (?1, ?2)",
        [snapshot.id, JSON.stringify(teaching)],
      );
    }
    this.#database.execute(
      `INSERT INTO marea_runs
        (id, student_id, class_id, snapshot_id, client_session_id,
         project_display_name, state, opened_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)`,
      [
        input.proposedRunId,
        input.student.userId,
        classId,
        snapshot.id,
        input.clientSessionId,
        input.projectDisplayName,
        input.openedAt,
      ],
    );
    const activated = CanonicalRunEventSchema.parse({
      eventId: input.activatedEventId,
      eventType: "run-activated",
      occurredAt: input.openedAt,
      sequence: 1,
    });
    this.insertEvent(input.proposedRunId, activated);
    this.#database.execute(
      `INSERT INTO marea_active_runs
        (run_id, student_id, class_id, project_display_name, started_at,
         last_activity_at, highest_durable_sequence, pending_approval)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1, 0)`,
      [
        input.proposedRunId,
        input.student.userId,
        classId,
        input.projectDisplayName,
        input.openedAt,
      ],
    );
    return snapshot;
  }

  private loadIdempotent(row: SqliteRow, input: OpenStoredRunInput): StoredRun {
    if (rowText(row, "fingerprint") !== input.fingerprint) {
      requestConflict();
    }
    return this.loadRun(rowText(row, "run_id"), input.student.userId);
  }

  private loadRun(runId: string, studentId: string): StoredRun {
    const row = this.#database.readOne(
      `SELECT runs.id, runs.state, snapshots.public_snapshot_json,
        snapshots.provider_route_json
        FROM marea_runs runs
        JOIN marea_run_snapshots snapshots ON snapshots.id = runs.snapshot_id
        WHERE runs.id = ?1 AND runs.student_id = ?2`,
      [runId, studentId],
    );
    if (row === undefined) {
      unavailable();
    }
    rowJson(row, "provider_route_json", StoredProviderRouteSchema);
    return {
      runId: rowText(row, "id"),
      snapshot: rowJson(row, "public_snapshot_json", StudentRunSnapshotSchema),
      state: rowText(row, "state"),
    };
  }

  private rememberOpen(input: OpenStoredRunInput, runId: string): void {
    this.#database.execute(
      `INSERT INTO marea_run_open_requests
        (student_id, idempotency_key, fingerprint, run_id) VALUES (?1, ?2, ?3, ?4)`,
      [input.student.userId, input.idempotencyKey, input.fingerprint, runId],
    );
  }

  private rotateLease(runId: string, input: OpenStoredRunInput): void {
    this.#database.execute(
      "UPDATE marea_run_leases SET revoked_at = ?2 WHERE run_id = ?1 AND revoked_at IS NULL",
      [runId, input.issuedAt],
    );
    this.#database.execute(
      `INSERT INTO marea_run_leases
        (id, run_id, student_id, token_hash, issued_at, expires_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      [
        input.leaseId,
        runId,
        input.student.userId,
        input.leaseTokenHash,
        input.issuedAt,
        input.expiresAt,
      ],
    );
  }

  private requiredProjection(runId: string): SqliteRow {
    const row = this.#database.readOne(
      `SELECT highest_durable_sequence, last_activity_at, pending_approval
        FROM marea_active_runs WHERE run_id = ?1`,
      [runId],
    );
    if (row === undefined) {
      unavailable();
    }
    return row;
  }

  private closeActiveRun(
    runId: string,
    input: CloseStoredRunInput | CloseAuthenticatedRunInput,
  ): CloseStoredRunResult {
    const projection = this.requiredProjection(runId);
    const sequence = rowInteger(projection, "highest_durable_sequence") + 1;
    const event = CanonicalRunEventSchema.parse({
      eventId: input.closingEventId,
      eventType: "run-closed",
      occurredAt: input.closedAt,
      reason: input.reason,
      sequence,
    });
    this.insertEvent(runId, event);
    this.#database.execute(
      `UPDATE marea_runs SET state = 'closed', closed_at = ?2, close_reason = ?3 WHERE id = ?1`,
      [runId, input.closedAt, input.reason],
    );
    this.#database.execute("DELETE FROM marea_active_runs WHERE run_id = ?1", [runId]);
    this.#database.execute(
      "UPDATE marea_run_leases SET revoked_at = ?2 WHERE run_id = ?1 AND revoked_at IS NULL",
      [runId, input.closedAt],
    );
    return { alreadyClosed: false, runId };
  }

  private appendEvent(runId: string, event: CanonicalRunEvent, highest: number): boolean {
    if (event.eventType === "run-activated" || event.eventType === "run-closed") {
      requestConflict();
    }
    const existing = this.#database.readOne(
      "SELECT run_id, sequence, payload_json FROM marea_run_events WHERE event_id = ?1",
      [event.eventId],
    );
    if (existing !== undefined) {
      const same =
        rowText(existing, "run_id") === runId &&
        rowInteger(existing, "sequence") === event.sequence &&
        rowText(existing, "payload_json") === eventJson(event);
      if (!same) {
        requestConflict();
      }
      return false;
    }
    if (event.sequence !== highest + 1) {
      requestConflict();
    }
    this.insertEvent(runId, event);
    return true;
  }

  private insertEvent(runId: string, event: CanonicalRunEvent): void {
    validateStartupEvent(this.#database, runId, event);
    this.#database.execute(
      `INSERT INTO marea_run_events
        (event_id, run_id, sequence, occurred_at, event_type, payload_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      [event.eventId, runId, event.sequence, event.occurredAt, event.eventType, eventJson(event)],
    );
  }
}
