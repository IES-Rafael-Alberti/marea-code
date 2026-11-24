import { randomUUID } from "node:crypto";
import type { InsightsRequest } from "@marea/protocol";
import type { AuthenticatedIdentity, Clock } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { LearningProgress } from "./progress.js";
import type { EducationalInference } from "./inference.js";
import { type EducationalRoute } from "./configuration.js";
import { InsightsFailure } from "./model-output.boundary.js";
import { sourceOf, type Row } from "./report-sources.js";
import { evaluateSource } from "./report-evaluation.js";
import { computedDenominators, validateFindings } from "./report-findings.js";
import { synthesize } from "./report-synthesis.js";
import { InputSchema, ReportRefusal, ResultSchema, type Evidence } from "./reports-model.js";

const MAX_RUNS = 200;
const MAX_INPUT_BYTES = 8 * 1048576;
/** A browser clock this far ahead of the server is clamped; further ahead is refused. */
export const END_SKEW_TOLERANCE_MS = 300_000;
/** Consecutive provider or deadline failures after which the remaining runs are not attempted. */
const MAX_INFRASTRUCTURE_FAILURES = 3;
const INFRASTRUCTURE = new Set(["provider", "deadline"]);
/** Failures that would repeat for every remaining run. */
const FATAL = new Set(["budget", "unconfigured"]);
/** A report with no progress for this many model deadlines is considered stuck. */
const STALE_DEADLINES = 4;

/** Content-free operator diagnostics: closed codes and identifiers, never student material. */
export type ReportDiagnostic = Readonly<Record<string, string | number>>;
function writeDiagnostic(entry: ReportDiagnostic): void {
  process.stderr.write(`${JSON.stringify({ component: "class-reports", ...entry })}\n`);
}

export class ClassReports {
  private active: {
    id: string;
    controller: AbortController;
    identity: AuthenticatedIdentity;
    classId: string;
    /** Server time of the last sign of life, which bounds how long a stuck report may run. */
    progressAt: string;
  } | null = null;
  diagnostics: (entry: ReportDiagnostic) => void = writeDiagnostic;
  constructor(
    readonly progress: LearningProgress,
    readonly inference: EducationalInference,
    readonly clock: Clock,
    public route: EducationalRoute | undefined,
  ) {}
  private get(id: string, classId: string) {
    const row = this.progress.database.readOne(
      "SELECT * FROM marea_class_reports WHERE id = ?1 AND class_id = ?2",
      [id, classId],
    );
    if (row === undefined) throw new TeacherDomainError("request.conflict");
    return row;
  }
  generate(identity: AuthenticatedIdentity, query: Extract<InsightsRequest, { kind: "generate" }>) {
    const route = this.route;
    if (route === undefined) throw new TeacherDomainError("request.conflict");
    const now = Date.parse(this.clock.now());
    if (Date.parse(query.to) - now > END_SKEW_TOLERANCE_MS)
      throw new ReportRefusal("invalid-period");
    // A browser clock slightly ahead of the server is clamped instead of refused.
    const to = Date.parse(query.to) > now ? this.clock.now() : query.to;
    if (query.from >= to || Date.parse(to) - Date.parse(query.from) > 366 * 86400000)
      throw new ReportRefusal("invalid-period");
    return this.progress.database.transaction(() => {
      this.progress.require(identity, query.classId);
      const previous = this.progress.database.readOne(
        "SELECT id FROM marea_class_reports WHERE owner_id = ?1 AND request_id = ?2",
        [identity.userId, query.requestId],
      );
      if (previous !== undefined) {
        const prior = this.read(String(previous.id), query.classId);
        const drift = Date.parse(query.to) - Date.parse(prior.to);
        if (prior.from !== query.from || drift < 0 || drift > END_SKEW_TOLERANCE_MS)
          throw new TeacherDomainError("request.conflict");
        return prior;
      }
      if (
        this.progress.database.readOne(
          "SELECT id FROM marea_class_reports WHERE class_id = ?1 AND state IN ('queued','running')",
          [query.classId],
        ) !== undefined
      )
        throw new ReportRefusal("in-progress");
      const runs = this.progress.database.readAll(
        `SELECT r.id, r.student_id, s.public_snapshot_json, t.teaching_json FROM marea_runs r JOIN marea_run_snapshots s ON s.id = r.snapshot_id JOIN marea_run_teaching_snapshots t ON t.snapshot_id = r.snapshot_id WHERE r.class_id = ?1 AND EXISTS(SELECT 1 FROM marea_run_events e WHERE e.run_id = r.id AND e.occurred_at >= ?2 AND e.occurred_at <= ?3) ORDER BY r.student_id,r.opened_at,r.id LIMIT 201`,
        [query.classId, query.from, to],
      );
      if (runs.length > MAX_RUNS) throw new ReportRefusal("too-large");
      const aliases = new Map<string, string>();
      const sources = runs.map((r) => {
        const studentId = String(r.student_id);
        const alias = aliases.get(studentId) ?? `A${String(aliases.size + 1).padStart(3, "0")}`;
        aliases.set(studentId, alias);
        return sourceOf(this.progress.database, r, to, alias, route);
      });
      const input = InputSchema.parse({
        from: query.from,
        to,
        locale: query.locale,
        sources,
        route,
      });
      if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES)
        throw new ReportRefusal("too-large");
      const id = randomUUID();
      this.progress.database.execute(
        "INSERT INTO marea_class_reports (id,class_id,owner_id,request_id,created_at,state,input_json) VALUES (?1,?2,?3,?4,?5,'queued',?6)",
        [
          id,
          query.classId,
          identity.userId,
          query.requestId,
          this.clock.now(),
          JSON.stringify(input),
        ],
      );
      for (const source of sources)
        this.progress.database.execute("INSERT INTO marea_class_report_sources VALUES (?1,?2)", [
          id,
          source.runId,
        ]);
      return this.read(id, query.classId);
    });
  }
  read(id: string, classId: string) {
    const row = this.get(id, classId);
    if (row.state === "invalidated")
      return {
        id,
        state: "invalidated",
        createdAt: String(row.created_at),
        from: "",
        to: "",
        completed: 0,
        total: 0,
        error: "evidence-deleted",
        result: null,
      };
    const input = InputSchema.parse(JSON.parse(String(row.input_json)));
    return {
      id,
      state: String(row.state),
      createdAt: String(row.created_at),
      budget: this.inference.usage(`report:${id}`, input.route),
      locale: input.locale,
      from: input.from,
      to: input.to,
      completed: Number(row.completed),
      total: input.sources.length,
      error: row.error,
      students: input.sources.map((s) => ({
        alias: s.alias,
        studentId: s.studentId,
        displayName: String(
          this.progress.database.readOne("SELECT display_name FROM marea_users WHERE id = ?1", [
            s.studentId,
          ])?.display_name ?? s.alias,
        ),
      })),
      result:
        row.result_json === null ? null : ResultSchema.parse(JSON.parse(String(row.result_json))),
    };
  }
  /** Newest first; a page continues after the given report, whose identifier is random. */
  list(classId: string, after: string | null) {
    return this.progress.database
      .readAll(
        `SELECT id, state, created_at AS createdAt, completed,
          COALESCE(json_extract(input_json, '$.from'), '') AS "from",
          COALESCE(json_extract(input_json, '$.to'), '') AS "to",
          COALESCE(json_array_length(input_json, '$.sources'), 0) AS total
        FROM marea_class_reports WHERE class_id = ?1 AND (?2 IS NULL OR (created_at, id) <
          (SELECT created_at, id FROM marea_class_reports WHERE id = ?2 AND class_id = ?1))
        ORDER BY created_at DESC, id DESC LIMIT 51`,
        [classId, after],
      )
      .map((row) => ({
        id: String(row.id),
        state: String(row.state),
        createdAt: String(row.createdAt),
        from: String(row.from),
        to: String(row.to),
        completed: Number(row.completed),
        total: Number(row.total),
      }));
  }
  cancel(id: string, classId: string): void {
    this.get(id, classId);
    this.progress.database.execute(
      "UPDATE marea_class_reports SET state = 'cancelled' WHERE id = ?1 AND state IN ('queued','running')",
      [id],
    );
    if (this.active?.id === id) this.active.controller.abort();
  }
  retry(identity: AuthenticatedIdentity, id: string, classId: string) {
    const row = this.get(id, classId);
    if (
      this.progress.database.readOne(
        "SELECT id FROM marea_class_reports WHERE class_id = ?1 AND state IN ('queued','running')",
        [classId],
      ) !== undefined
    )
      throw new TeacherDomainError("request.conflict");
    if (!["failed", "interrupted", "cancelled"].includes(String(row.state)))
      throw new TeacherDomainError("request.conflict");
    const input = InputSchema.parse(JSON.parse(String(row.input_json)));
    const next = randomUUID();
    this.progress.database.transaction(() => {
      this.progress.require(identity, classId);
      this.progress.database.execute(
        "INSERT INTO marea_class_reports (id,class_id,owner_id,request_id,created_at,state,input_json) VALUES (?1,?2,?3,?4,?5,'queued',?6)",
        [next, classId, identity.userId, next, this.clock.now(), JSON.stringify(input)],
      );
      for (const source of input.sources)
        this.progress.database.execute("INSERT INTO marea_class_report_sources VALUES (?1,?2)", [
          next,
          source.runId,
        ]);
    });
    return this.read(next, classId);
  }
  async tick(): Promise<void> {
    if (this.active !== null) {
      this.supervise(this.active);
      return;
    }
    const row = this.progress.database.readOne(
      "SELECT * FROM marea_class_reports WHERE state = 'queued' ORDER BY created_at,id LIMIT 1",
    );
    if (row === undefined) return;
    const id = String(row.id),
      controller = new AbortController();
    const identity: AuthenticatedIdentity = {
      userId: String(row.owner_id),
      role: "teacher",
      classId: null,
      displayName: "",
    };
    const active = {
      id,
      controller,
      identity,
      classId: String(row.class_id),
      progressAt: this.clock.now(),
    };
    this.active = active;
    try {
      this.progress.require(identity, active.classId);
      this.progress.database.execute(
        "UPDATE marea_class_reports SET state = 'running' WHERE id = ?1",
        [id],
      );
      await this.analyse(row, active);
    } catch (error) {
      if (!controller.signal.aborted)
        this.fail(
          id,
          error instanceof InsightsFailure ? error.code : "analysis-failed",
          error instanceof Error ? error.name : "unknown",
        );
    } finally {
      // A report released as stale must not clear a newer one.
      if (this.active === active) this.active = null;
    }
  }
  /** Revoked access or a report without progress for too long is stopped and releases the class. */
  private supervise(active: NonNullable<ClassReports["active"]>): void {
    try {
      this.progress.require(active.identity, active.classId);
    } catch {
      active.controller.abort();
      this.progress.database.execute(
        "UPDATE marea_class_reports SET state = 'failed',error = 'access-revoked' WHERE id = ?1 AND state = 'running'",
        [active.id],
      );
      return;
    }
    const idle = Date.parse(this.clock.now()) - Date.parse(active.progressAt);
    if (idle <= STALE_DEADLINES * this.inference.deadlineMs) return;
    active.controller.abort();
    this.progress.database.execute(
      "UPDATE marea_class_reports SET state = 'interrupted',error = 'deadline' WHERE id = ?1 AND state = 'running'",
      [active.id],
    );
    this.diagnostics({ event: "report-stalled", reportId: active.id, code: "deadline" });
    this.active = null;
  }
  private fail(id: string, code: string, cause: string): void {
    this.progress.database.execute(
      "UPDATE marea_class_reports SET state = 'failed', error = ?2 WHERE id = ?1 AND state IN ('running','queued')",
      [id, code],
    );
    this.diagnostics({
      event: "report-failed",
      reportId: id,
      code,
      cause,
    });
  }
  private async analyse(row: Row, active: NonNullable<ClassReports["active"]>): Promise<void> {
    const { id, controller } = active;
    const accessible = () => {
      this.progress.require(active.identity, active.classId);
      return (
        !controller.signal.aborted &&
        this.progress.database.readOne(
          "SELECT id FROM marea_class_reports WHERE id = ?1 AND state = 'running'",
          [id],
        ) !== undefined
      );
    };
    const input = InputSchema.parse(JSON.parse(String(row.input_json)));
    const evidence: Evidence[] = [];
    let firstFailure: InsightsFailure | undefined;
    let streak = 0;
    for (const source of input.sources) {
      if (!accessible()) return;
      const evaluated = await evaluateSource(
        this.inference,
        source,
        input,
        `report:${id}`,
        controller.signal,
      );
      evidence.push(evaluated.evidence);
      const failure = evaluated.failure;
      if (evaluated.reason !== undefined)
        this.diagnostics({
          event: "report-run-unavailable",
          reportId: id,
          runId: source.runId,
          reason: evaluated.reason,
        });
      firstFailure ??= failure;
      streak = failure !== undefined && INFRASTRUCTURE.has(failure.code) ? streak + 1 : 0;
      if (
        failure !== undefined &&
        (FATAL.has(failure.code) || streak >= MAX_INFRASTRUCTURE_FAILURES)
      )
        throw failure;
      active.progressAt = this.clock.now();
      this.progress.database.execute(
        "UPDATE marea_class_reports SET completed = ?2 WHERE id = ?1 AND state = 'running'",
        [id, evidence.length],
      );
    }
    if (!accessible()) return;
    const usable = evidence.filter((e) => e.status !== "unavailable");
    if (usable.length === 0 && firstFailure !== undefined) throw firstFailure;
    const modelled = await synthesize(
      this.inference,
      input,
      `report:${id}`,
      usable,
      controller.signal,
    );
    const checked = validateFindings(modelled.synthesis, usable);
    const computed = computedDenominators(checked.synthesis, usable);
    if (!accessible()) return;
    const adjusted = modelled.dropped + checked.adjusted + computed.adjusted;
    this.progress.database.execute(
      "UPDATE marea_class_reports SET state = 'complete', result_json = ?2 WHERE id = ?1",
      [
        id,
        JSON.stringify({
          synthesis: computed.synthesis,
          evidence,
          partial: adjusted > 0 || evidence.some((e) => e.status === "unavailable"),
        }),
      ],
    );
    if (adjusted > 0)
      this.diagnostics({ event: "report-findings-adjusted", reportId: id, adjusted });
  }
  stop(): void {
    this.active?.controller.abort();
  }
}
