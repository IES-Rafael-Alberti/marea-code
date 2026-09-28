import {
  AgentAdapterError,
  ModelStreamError,
  normalizeDiagnosticCause,
} from "@marea/deepagents-adapter";

import {
  NoActiveRunError,
  StoredTurnFailure,
  TurnAttemptFailed,
  type TurnFailureInfo,
} from "./contracts.js";
import { StudentHttpError } from "./http-client.boundary.js";
import { sanitizeContextField } from "./session-context.js";

/**
 * Classifies typed failures without parsing prose. The server's retry flag
 * remains authoritative even when output has been saved. Transport errors
 * are classified at the HTTP boundary; unexpected failures are not retried.
 * Cancellation is presented separately by the executor.
 */

const MAX_DETAIL_LENGTH = 1_024;
const DETERMINISTIC_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "invalid-replay-prefix",
  "approval-not-pending",
  "approval-review-mismatch",
  "approval-message-mismatch",
]);

/**
 * Wraps a failed stream read with its persisted prefix. The classifier
 * reads the prefix length and the cause; prose is never parsed.
 */
export function attemptFailure(prefix: string, error: unknown): TurnAttemptFailed {
  return new TurnAttemptFailed(
    prefix,
    error instanceof Error ? error : new Error("The agent stream threw an unexpected value."),
  );
}

type RecognizedFailure = ModelStreamError | StudentHttpError | NoActiveRunError;

function isRecognized(error: Error): error is RecognizedFailure {
  return (
    error instanceof ModelStreamError ||
    error instanceof StudentHttpError ||
    error instanceof NoActiveRunError
  );
}

/**
 * The deepest recognized failure on the cause chain, or null. Post-order,
 * so the root cause wins over its wrappers; cycle-safe through `seen`.
 */
function deepestRecognized(
  error: unknown,
  seen: Set<unknown> = new Set<unknown>(),
): RecognizedFailure | null {
  if (!(error instanceof Error) || seen.has(error)) return null;
  seen.add(error);
  const inner = deepestRecognized(error.cause, seen);
  if (inner !== null) return inner;
  return isRecognized(error) ? error : null;
}

function exceptionDetail(error: Error): string {
  return sanitizeContextField(`${error.name}: ${error.message}`, MAX_DETAIL_LENGTH);
}

function classifyRecognized(recognized: RecognizedFailure, prefix: string): TurnFailureInfo {
  const hasPrefix = prefix !== "";
  if (recognized instanceof ModelStreamError) {
    // Persisted output never overrides an explicit server refusal.
    return {
      code: recognized.streamCode,
      detail: sanitizeContextField(recognized.streamMessage, MAX_DETAIL_LENGTH),
      hasPrefix,
      kind:
        recognized.streamCode === "deadline-exceeded" ||
        recognized.streamCode === "budget-exhausted" ||
        recognized.streamCode === "concurrency-limited"
          ? recognized.streamCode
          : recognized.streamCode === "authentication-failed" ||
              recognized.streamCode === "usage-invalid" ||
              recognized.streamCode === "invalid-response"
            ? "request-failed"
            : "provider-interrupted",
      recoverable: true,
      retryable: recognized.streamRetryable,
    };
  }
  if (recognized instanceof StudentHttpError) {
    return {
      detail: "",
      hasPrefix,
      kind: hasPrefix ? "provider-interrupted" : "request-failed",
      recoverable: true,
      retryable: recognized.retryable,
    };
  }
  return {
    detail: "",
    hasPrefix,
    kind: "session-unavailable",
    recoverable: false,
    retryable: false,
  };
}

function classifyTopLevel(error: unknown, prefix: string): TurnFailureInfo {
  const hasPrefix = prefix !== "";
  if (error instanceof AgentAdapterError) {
    if (DETERMINISTIC_REFUSAL_CODES.has(error.code)) {
      return {
        detail: "",
        hasPrefix,
        kind: "request-failed",
        recoverable: true,
        retryable: false,
      };
    }
    if (error.code === "upstream-execution-failed") {
      const diagnostic = normalizeDiagnosticCause(error.cause);
      return {
        detail: sanitizeContextField(
          `${diagnostic.name}: ${diagnostic.message}`,
          MAX_DETAIL_LENGTH,
        ),
        hasPrefix,
        kind: "unexpected",
        recoverable: true,
        retryable: false,
      };
    }
    return {
      detail: exceptionDetail(error),
      hasPrefix,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    };
  }
  if (error instanceof Error) {
    return {
      detail: exceptionDetail(error),
      hasPrefix,
      kind: "unexpected",
      recoverable: true,
      retryable: false,
    };
  }
  return {
    detail: typeof error === "string" ? sanitizeContextField(error, MAX_DETAIL_LENGTH) : "",
    hasPrefix,
    kind: "unexpected",
    recoverable: true,
    retryable: false,
  };
}

function classifyAttempt(error: unknown, prefix: string): TurnFailureInfo {
  const recognized = deepestRecognized(error);
  if (recognized !== null) return classifyRecognized(recognized, prefix);
  return classifyTopLevel(error, prefix);
}

export function classifyTurnFailure(error: unknown): TurnFailureInfo {
  if (error instanceof StoredTurnFailure) return error.failure;
  if (error instanceof TurnAttemptFailed) {
    return classifyAttempt(error.cause, error.prefix);
  }
  return classifyAttempt(error, "");
}
