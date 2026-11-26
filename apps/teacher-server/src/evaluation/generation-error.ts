import type { EvaluationFailure } from "@marea/protocol";

export class EvaluationGenerationError extends Error {
  public constructor(public readonly code: EvaluationFailure) {
    super("The evaluation could not produce a reviewable draft.");
    this.name = "EvaluationGenerationError";
  }
}

/** Why a model answer was not a reviewable draft. Internal diagnostics only, never its content. */
export type InvalidDraftReason =
  "tool-call" | "oversized" | "truncated" | "unfinished" | "malformed" | "schema" | "criteria";

export interface EvaluationDraftDiagnostic {
  readonly runId: string;
  readonly evaluationId: string;
  readonly reason: InvalidDraftReason;
  readonly outputBytes: number;
}
