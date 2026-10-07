import type { CanonicalRunEvent, SessionExportQuery } from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";

export interface ExportUsage {
  readonly requestId: string;
  readonly attempt: number;
  readonly purpose: string;
  readonly state: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUnits: number | null;
  readonly costUnit: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
export interface ExportSession {
  readonly runId: string;
  readonly classId: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly className: string;
  readonly projectName: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly events: readonly CanonicalRunEvent[];
  readonly usage: readonly ExportUsage[];
}
export interface SessionExportRepository {
  read(identity: AuthenticatedIdentity, query: SessionExportQuery): readonly ExportSession[];
  students(
    identity: AuthenticatedIdentity,
  ): readonly { id: string; name: string; classId: string }[];
}
export class SessionExportError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 503) {
    super("Session export unavailable.");
  }
}
export interface SessionExportEndpoint {
  download(identity: AuthenticatedIdentity, input: Uint8Array): Uint8Array<ArrayBuffer>;
  students(
    identity: AuthenticatedIdentity,
  ): readonly { id: string; name: string; classId: string }[];
}
