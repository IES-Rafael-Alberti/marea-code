import {
  TeacherNoticeQueryResponseSchema,
  type TeacherNoticeQuery,
  type TeacherNoticeStatus,
  AcknowledgeNoticeResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  PendingNoticesResponseSchema,
  PublishTeacherNoticeRequestSchema,
  PublishTeacherNoticeResponseSchema,
  type AcknowledgeNoticeRequest,
  type PendingNoticesRequest,
  type PublishTeacherNoticeRequest,
  type TeacherNotice,
} from "@marea/protocol";

import type {
  AuthenticatedIdentity,
  Clock,
  IdGenerator,
  SecretDigest,
} from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";

export interface PublishNoticeInput {
  readonly noticeId: string;
  readonly teacherId: string;
  readonly teacherDisplayName: string;
  readonly runId: string;
  readonly source: TeacherNotice["source"];
  readonly text: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

export interface NoticeRepository {
  lookup(teacherId: string, runId: string, key: string): TeacherNoticeStatus | null;
  publish(input: PublishNoticeInput): TeacherNotice;
  pending(studentId: string, limit: number): readonly TeacherNotice[];
  acknowledge(studentId: string, noticeId: string, now: string): string;
}

export interface NoticeServiceOptions {
  readonly repository: NoticeRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly digest: SecretDigest;
}

export class NoticeService {
  public constructor(private readonly options: NoticeServiceOptions) {}

  public publish(identity: AuthenticatedIdentity, request: PublishTeacherNoticeRequest) {
    this.requireRole(identity, "teacher");
    const parsed = PublishTeacherNoticeRequestSchema.parse(request);
    const source = "teacher-message" as const;
    const notice = this.options.repository.publish({
      noticeId: this.options.ids.createId("event"),
      teacherId: identity.userId,
      teacherDisplayName: identity.displayName,
      runId: parsed.runId,
      source,
      text: parsed.text,
      createdAt: this.options.clock.now(),
      idempotencyKey: parsed.idempotencyKey,
      fingerprint: this.options.digest.digest(JSON.stringify([parsed.runId, source, parsed.text])),
    });
    return PublishTeacherNoticeResponseSchema.parse({
      kind: "teacher-notice-published",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: parsed.requestId,
      notice,
    });
  }

  public lookup(identity: AuthenticatedIdentity, request: TeacherNoticeQuery) {
    this.requireRole(identity, "teacher");
    return TeacherNoticeQueryResponseSchema.parse({
      kind: "teacher-notice-status",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      runId: request.runId,
      idempotencyKey: request.idempotencyKey,
      publication: this.options.repository.lookup(
        identity.userId,
        request.runId,
        request.idempotencyKey,
      ),
    });
  }

  public pending(identity: AuthenticatedIdentity, request: PendingNoticesRequest) {
    this.requireRole(identity, "student");
    return PendingNoticesResponseSchema.parse({
      kind: "pending-notices-response",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      notices: this.options.repository.pending(identity.userId, request.limit),
    });
  }

  public acknowledge(identity: AuthenticatedIdentity, request: AcknowledgeNoticeRequest) {
    this.requireRole(identity, "student");
    return AcknowledgeNoticeResponseSchema.parse({
      kind: "teacher-notice-acknowledged",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      noticeId: request.noticeId,
      acknowledgedAt: this.options.repository.acknowledge(
        identity.userId,
        request.noticeId,
        this.options.clock.now(),
      ),
    });
  }

  private requireRole(identity: AuthenticatedIdentity, role: AuthenticatedIdentity["role"]): void {
    if (identity.role !== role) throw new TeacherDomainError("dashboard.forbidden");
  }
}
