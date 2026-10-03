import { anonymizeDraft } from "./anonymize.js";
import { TeachingSnapshotContentSchema } from "../teaching/configuration/configuration-schema.js";
import { validateEvaluationDraft } from "../evaluation/validate-draft.js";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import {
  EvaluationDraftSchema,
  StudentRunSnapshotSchema,
  ReportSynthesisSchema,
  type InsightsRequest,
  type ReportSynthesis,
} from "@marea/protocol";
import type { AuthenticatedIdentity, Clock } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { LearningProgress } from "./progress.js";
import type { EducationalInference } from "./inference.js";
import { type EducationalRoute } from "./configuration.js";

import {
  SourceSchema,
  InputSchema,
  ResultSchema,
  EVALUATE,
  SYNTHESIZE,
  type Evidence,
} from "./reports-model.js";
export class ClassReports {
  private active: {
    id: string;
    controller: AbortController;
    identity: AuthenticatedIdentity;
    classId: string;
  } | null = null;
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
    if (
      this.route === undefined ||
      query.from >= query.to ||
      Date.parse(query.to) > Date.parse(this.clock.now()) ||
      Date.parse(query.to) - Date.parse(query.from) > 366 * 86400000
    )
      throw new TeacherDomainError("request.conflict");
    return this.progress.database.transaction(() => {
      this.progress.require(identity, query.classId);
      const previous = this.progress.database.readOne(
        "SELECT id FROM marea_class_reports WHERE owner_id = ?1 AND request_id = ?2",
        [identity.userId, query.requestId],
      );
      if (previous !== undefined) {
        const prior = this.read(String(previous.id), query.classId);
        if (prior.from !== query.from || prior.to !== query.to)
          throw new TeacherDomainError("request.conflict");
        return prior;
      }
      if (
        this.progress.database.readOne(
          "SELECT id FROM marea_class_reports WHERE class_id = ?1 AND state IN ('queued','running')",
          [query.classId],
        ) !== undefined
      )
        throw new TeacherDomainError("request.conflict");
      const runs = this.progress.database.readAll(
        `SELECT r.id, r.student_id, s.public_snapshot_json, t.teaching_json FROM marea_runs r JOIN marea_run_snapshots s ON s.id = r.snapshot_id JOIN marea_run_teaching_snapshots t ON t.snapshot_id = r.snapshot_id WHERE r.class_id = ?1 AND EXISTS(SELECT 1 FROM marea_run_events e WHERE e.run_id = r.id AND e.occurred_at >= ?2 AND e.occurred_at <= ?3) ORDER BY r.student_id,r.opened_at,r.id LIMIT 201`,
        [query.classId, query.from, query.to],
      );
      if (runs.length > 200) throw new TeacherDomainError("request.conflict");
      const aliases = new Map<string, string>();
      const sources = runs.map((r) => {
        const studentId = String(r.student_id);
        const alias = aliases.get(studentId) ?? `A${String(aliases.size + 1).padStart(3, "0")}`;
        aliases.set(studentId, alias);
        const runId = String(r.id);
        const snapshot = StudentRunSnapshotSchema.parse(JSON.parse(String(r.public_snapshot_json)));
        const teaching = TeachingSnapshotContentSchema.parse(JSON.parse(String(r.teaching_json)));
        const approved = this.progress.database.readOne(
          "SELECT draft_json FROM marea_evaluations WHERE run_id = ?1 AND state = 'approved' ORDER BY generation DESC LIMIT 1",
          [runId],
        );
        const person = this.progress.database.readOne(
          "SELECT display_name,login FROM marea_users WHERE id = ?1",
          [studentId],
        );
        const events = this.progress.database.readAll(
          "SELECT payload_json FROM marea_run_events WHERE run_id = ?1 AND event_type IN ('student-message','assistant-message','tool-finished','project-change') AND occurred_at <= ?2 ORDER BY sequence LIMIT 2001",
          [runId, query.to],
        );
        let material = JSON.stringify({
          teaching,
          events: events.map((e) => z.json().parse(JSON.parse(String(e.payload_json)))),
        });
        for (const identifier of [person?.display_name, person?.login])
          if (typeof identifier === "string" && identifier.length > 1)
            material = material.replaceAll(identifier, alias);
        return {
          runId,
          studentId,
          alias,
          mode: snapshot.agentMode,
          teaching,
          skills: teaching.didacticSkills.map((s) => s.id),
          material: events.length > 2000 || Buffer.byteLength(material) > 262144 ? "" : material,
          approved:
            approved === undefined
              ? null
              : anonymizeDraft(
                  EvaluationDraftSchema.parse(JSON.parse(String(approved.draft_json))),
                  [String(person?.display_name ?? ""), String(person?.login ?? "")],
                  alias,
                ),
        };
      });
      const input = InputSchema.parse({
        from: query.from,
        to: query.to,
        locale: query.locale,
        sources,
        route: this.route,
      });
      if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1048576)
        throw new TeacherDomainError("request.conflict");
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
      try {
        this.progress.require(this.active.identity, this.active.classId);
      } catch {
        this.active.controller.abort();
        this.progress.database.execute(
          "UPDATE marea_class_reports SET state = 'failed',error = 'access-revoked' WHERE id = ?1 AND state = 'running'",
          [this.active.id],
        );
      }
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
    this.active = { id, controller, identity, classId: String(row.class_id) };
    const accessible = () => {
      this.progress.require(identity, String(row.class_id));
      return (
        !controller.signal.aborted &&
        this.progress.database.readOne(
          "SELECT id FROM marea_class_reports WHERE id = ?1 AND state = 'running'",
          [id],
        ) !== undefined
      );
    };
    try {
      this.progress.require(identity, String(row.class_id));
      this.progress.database.execute(
        "UPDATE marea_class_reports SET state = 'running' WHERE id = ?1",
        [id],
      );
      const input = InputSchema.parse(JSON.parse(String(row.input_json)));
      const evidence: Evidence[] = [];
      for (const source of input.sources) {
        if (controller.signal.aborted || !accessible()) return;
        evidence.push(await this.evaluateSource(source, input, id, controller.signal));
        this.progress.database.execute(
          "UPDATE marea_class_reports SET completed = ?2 WHERE id = ?1 AND state = 'running'",
          [id, evidence.length],
        );
      }
      if (controller.signal.aborted || !accessible()) return;
      const usable = evidence.filter((e) => e.status !== "unavailable");
      const synthesis: ReportSynthesis =
        usable.length === 0
          ? {
              summary:
                input.locale === "es"
                  ? "No hay evidencia suficiente para generar el informe."
                  : input.locale === "eu"
                    ? "Ez dago txostena sortzeko nahikoa ebidentziarik."
                    : "Insufficient evidence to generate a report.",
              findings: [],
              recommendation: "",
            }
          : await this.inference.generate(
              input.route,
              `report:${id}`,
              SYNTHESIZE,
              { locale: input.locale, evidence: usable },
              ReportSynthesisSchema,
              controller.signal,
            );
      validateFindings(synthesis, usable);
      if (!accessible()) return;
      this.progress.database.execute(
        "UPDATE marea_class_reports SET state = 'complete', result_json = ?2 WHERE id = ?1",
        [
          id,
          JSON.stringify({
            synthesis: computedDenominators(synthesis, usable),
            evidence,
            partial: evidence.some((e) => e.status === "unavailable"),
          }),
        ],
      );
    } catch {
      if (!controller.signal.aborted)
        this.progress.database.execute(
          "UPDATE marea_class_reports SET state = 'failed', error = 'analysis-failed' WHERE id = ?1 AND state IN ('running','queued')",
          [id],
        );
    } finally {
      this.active = null;
    }
  }
  private async evaluateSource(
    source: z.infer<typeof SourceSchema>,
    input: z.infer<typeof InputSchema>,
    id: string,
    signal: AbortSignal,
  ): Promise<Evidence> {
    let evaluation = source.approved;
    let status: Evidence["status"] = evaluation === null ? "provisional" : "approved";
    if (evaluation === null) {
      try {
        if (source.material === "" || source.teaching.evaluationSkills.length === 0)
          throw new Error("missing-evidence");
        evaluation = await this.inference.generate(
          input.route,
          `report:${id}`,
          EVALUATE,
          { mode: source.mode, material: source.material, locale: input.locale },
          EvaluationDraftSchema,
          signal,
        );
        evaluation = validateEvaluationDraft(
          evaluation,
          source.mode,
          source.teaching.didacticSkills,
        );
      } catch {
        status = "unavailable";
        evaluation = null;
      }
    }
    return {
      runId: source.runId,
      alias: source.alias,
      mode: source.mode,
      skills: source.skills,
      status,
      evaluation,
    };
  }
  stop(): void {
    this.active?.controller.abort();
  }
}
export function validateFindings(synthesis: ReportSynthesis, evidence: readonly Evidence[]): void {
  for (const finding of synthesis.findings) {
    const eligible = evidence.filter(
      (e) =>
        e.mode === finding.mode &&
        (finding.skillIds.length === 0 || finding.skillIds.every((s) => e.skills.includes(s))),
    );
    const aliases = new Set(eligible.map((e) => e.alias));
    const ids = new Set(eligible.map((e) => e.runId));
    if (
      new Set(finding.evaluable).size !== finding.evaluable.length ||
      new Set(finding.affected).size !== finding.affected.length ||
      finding.evaluable.some((a) => !aliases.has(a)) ||
      finding.affected.some((a) => !finding.evaluable.includes(a)) ||
      finding.evidence.length === 0 ||
      finding.evidence.some((id) => !ids.has(id)) ||
      finding.affected.some(
        (alias) => !eligible.some((e) => e.alias === alias && finding.evidence.includes(e.runId)),
      )
    )
      throw new Error("invalid-findings");
  }
}

/** One student counts once per mode and assessed skill, regardless of session count. */
export function computedDenominators(
  synthesis: ReportSynthesis,
  evidence: readonly Evidence[],
): ReportSynthesis {
  return {
    ...synthesis,
    findings: synthesis.findings.map((finding) => {
      const evaluable = [
        ...new Set(
          evidence
            .filter(
              (e) =>
                e.mode === finding.mode &&
                e.status !== "unavailable" &&
                (finding.skillIds.length === 0 ||
                  finding.skillIds.every((skill) =>
                    e.evaluation?.criteria.some(
                      (c) => c.skillId === skill && c.result !== "no-evidence",
                    ),
                  )),
            )
            .map((e) => e.alias),
        ),
      ];
      if (finding.affected.some((alias) => !evaluable.includes(alias)))
        throw new Error("invalid-denominator");
      return { ...finding, evaluable };
    }),
  };
}
