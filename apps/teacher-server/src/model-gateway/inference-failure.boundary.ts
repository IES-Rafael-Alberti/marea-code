import { InferenceProviderError } from "@marea/plugin-api";

/** Safe local gateway failures; these are not provider plugin failures. */
export class InferenceFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "InferenceFailure";
  }
}

export function inferenceFailure(error: unknown): InferenceFailure {
  if (error instanceof InferenceFailure) return error;
  if (error instanceof InferenceProviderError)
    return new InferenceFailure(error.code, error.message, error.retryable);
  return new InferenceFailure("inference-failed", "The inference request failed.");
}

export interface InferenceDiagnostic {
  readonly runId: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly limitMs: number | null;
  readonly code: string;
  readonly emitted: boolean;
  readonly settlement: "settled" | "unknown" | "breached" | "not-admitted";
  readonly retryable: boolean;
  readonly retryBlockedBy: string | null;
}
export type InferenceDiagnosticSink = (event: InferenceDiagnostic) => void;

export function reportInference(
  sink: InferenceDiagnosticSink | undefined,
  event: InferenceDiagnostic,
): void {
  try {
    sink?.(Object.freeze(event));
  } catch {
    // Diagnostics must not change request or accounting outcomes.
  }
}
