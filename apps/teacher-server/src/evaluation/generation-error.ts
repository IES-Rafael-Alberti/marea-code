import type { EvaluationFailure } from "@marea/protocol";

export class EvaluationGenerationError extends Error {
  public constructor(public readonly code: EvaluationFailure) {
    super("The evaluation could not produce a reviewable draft.");
    this.name = "EvaluationGenerationError";
  }
}
