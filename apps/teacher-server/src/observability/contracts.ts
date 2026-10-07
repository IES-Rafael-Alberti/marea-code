import type { CanonicalRunEvent } from "@marea/protocol";
import type { ExportUsage } from "../session-export/contracts.js";
export interface TraceTurn {
  readonly runId: string;
  readonly studentId: string;
  readonly classId: string;
  readonly model: string;
  readonly provider: string;
  readonly events: readonly CanonicalRunEvent[];
  readonly usage: readonly ExportUsage[];
}
