import {
  TEACHER_HEALTH_FRESHNESS_MS,
  UtcTimestampSchema,
  TeacherHealthRequestSchema,
  TeacherHealthResponseSchema,
  UsageQuerySchema,
  UsageResponseSchema,
  type TeacherHealthRequest,
  type TeacherHealthResponse,
  type UsageEntry,
  type UsageQuery,
  type UsageResponse,
} from "@marea/protocol";
import type { AuthenticatedIdentity, Clock } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";

export interface UsageHealthRepository {
  requireTeacherClass(teacherId: string, classId: string): void;
  page(query: UsageQuery): readonly UsageEntry[];
  lastObservedAt(classId: string): string | null;
  transaction<T>(operation: () => T): T;
}

/** Synchronous transaction keeps membership and projection in the same authorized snapshot. */
export class UsageHealthService {
  constructor(
    private readonly repository: UsageHealthRepository,
    private readonly clock: Clock,
  ) {}

  queryUsage(identity: AuthenticatedIdentity, input: UsageQuery): UsageResponse {
    const query = UsageQuerySchema.parse(input);
    return this.authorized(identity, query.classId, () => {
      const rows = this.repository.page(query);
      const entries = rows.slice(0, query.limit);
      const priced = entries.filter((entry) => entry.cost.status === "priced").length;
      return UsageResponseSchema.parse({
        protocolVersion: query.protocolVersion,
        requestId: query.requestId,
        classId: query.classId,
        kind: "class-usage-result",
        generatedAt: this.clock.now(),
        from: query.from,
        until: query.until,
        scope: "page",
        pricing: priced === 0 ? "unavailable" : priced === entries.length ? "complete" : "partial",
        entries,
        nextAfterAttemptId:
          rows.length > query.limit
            ? entries.reduce<string | null>((_previous, entry) => entry.attemptId, null)
            : null,
      });
    });
  }

  readHealth(identity: AuthenticatedIdentity, input: TeacherHealthRequest): TeacherHealthResponse {
    const query = TeacherHealthRequestSchema.parse(input);
    return this.authorized(identity, query.classId, () => {
      const now = this.clock.now();
      const observedAt = UtcTimestampSchema.nullable()
        .catch(null)
        .parse(this.repository.lastObservedAt(query.classId));
      const age = Date.parse(now) - Date.parse(String(observedAt));
      const unknown = { status: "unknown", observedAt: null } as const;
      return TeacherHealthResponseSchema.parse({
        protocolVersion: query.protocolVersion,
        requestId: query.requestId,
        classId: query.classId,
        kind: "teacher-health-result",
        generatedAt: now,
        freshnessMs: TEACHER_HEALTH_FRESHNESS_MS,
        storage: { status: "available", observedAt: now },
        usageLedger:
          age < 0 || !Number.isFinite(age)
            ? unknown
            : {
                status: age <= TEACHER_HEALTH_FRESHNESS_MS ? "available" : "stale",
                observedAt,
              },
        inference: unknown,
        telemetryDelivery: unknown,
      });
    });
  }

  private authorized<T>(identity: AuthenticatedIdentity, classId: string, read: () => T): T {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    return this.repository.transaction(() => {
      this.repository.requireTeacherClass(identity.userId, classId);
      return read();
    });
  }
}
