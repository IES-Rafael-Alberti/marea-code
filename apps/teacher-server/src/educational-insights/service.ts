import { InsightsRequestSchema, type InsightsRequest } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { AuthenticatedIdentity, Clock } from "../identity/contracts.js";
import type { InferenceProviderResolver } from "../product-http/contracts.js";
import { renderReport } from "./report-html.js";
export { renderReport } from "./report-html.js";
import type { EducationalConfiguration } from "./configuration.js";
import { LearningProgress } from "./progress.js";
import { EducationalInference } from "./inference.js";
import { LiveAttentionMap } from "./live-map.js";
import { ClassReports } from "./reports.js";

export class EducationalInsightsService {
  readonly progress: LearningProgress;
  readonly inference: EducationalInference;
  readonly map: LiveAttentionMap;
  readonly reports: ClassReports;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    readonly database: SqliteApplicationDatabase,
    readonly clock: Clock,
    providers: InferenceProviderResolver,
    readonly configuration: EducationalConfiguration,
  ) {
    this.progress = new LearningProgress(database);
    this.inference = new EducationalInference(database, providers, clock);
    this.map = new LiveAttentionMap(this.progress, this.inference, clock, configuration.map);
    this.reports = new ClassReports(this.progress, this.inference, clock, configuration.reports);
  }
  read(identity: AuthenticatedIdentity, input: InsightsRequest) {
    const q = InsightsRequestSchema.parse(input);
    this.progress.require(identity, q.classId);
    return {
      protocolVersion: q.protocolVersion,
      requestId: q.requestId,
      classId: q.classId,
      kind: q.kind,
      data: this.dispatch(identity, q),
    };
  }
  private dispatch(identity: AuthenticatedIdentity, q: InsightsRequest) {
    switch (q.kind) {
      case "settings":
        return {
          ...this.progress.settings(q.classId),
          mapConfigured: this.configuration.map !== undefined,
          reportsConfigured: this.configuration.reports !== undefined,
        };
      case "configure":
        return this.progress.configure(q.classId, q.settings, q.expectedRevision, () => {
          this.progress.require(identity, q.classId);
        });
      case "map":
        return this.map.read(identity, q.classId, q.viewerId, q.visible);
      case "progress":
        return this.progress.read(q.classId, q.studentId, q.after);
      case "adjust":
        this.progress.adjust(
          q.classId,
          q.studentId,
          q.keys,
          q.level,
          q.reason,
          q.expectedRevision,
          identity.userId,
          this.clock.now(),
          () => {
            this.progress.require(identity, q.classId);
          },
        );
        return this.progress.read(q.classId, q.studentId, null);
      case "history":
        return {
          entries: this.database
            .readAll(
              "SELECT id,run_id AS runId,previous_level AS previousLevel,level,reason,actor,created_at AS createdAt FROM marea_learning_history WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3 AND id > ?4 ORDER BY id LIMIT 51",
              [q.classId, q.studentId, q.key, q.after],
            )
            .map((row) => ({
              ...row,
              id: Number(row.id),
              previousLevel: Number(row.previousLevel),
              level: Number(row.level),
            })),
        };
      case "generate":
        return this.reports.generate(identity, q);
      case "reports":
        return {
          entries: this.reports.list(q.classId, q.after),
          configured: this.configuration.reports !== undefined,
        };
      case "cancel":
        this.reports.cancel(q.reportId, q.classId);
        return this.reports.read(q.reportId, q.classId);
      case "retry":
        return this.reports.retry(identity, q.reportId, q.classId);
      case "report":
        return this.reports.read(q.reportId, q.classId);
      case "download":
        return { html: renderReport(this.reports.read(q.reportId, q.classId)) };
    }
  }
  heartbeat(runId: string): void {
    this.map.heartbeat(runId);
  }
  recover(): void {
    this.inference.ledger.recoverUnfinished(this.clock.now());
    this.database.execute(
      "UPDATE marea_class_reports SET state = 'interrupted',error = 'interrupted' WHERE state IN ('running','queued')",
    );
  }
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      const task = Promise.allSettled([this.map.tick(), this.reports.tick()]).then(() => undefined);
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    }, 1000);
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.map.stop();
    this.reports.stop();
    await Promise.all(this.pending);
  }
}
