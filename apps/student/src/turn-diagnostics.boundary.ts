import { AgentAdapterError, ModelStreamError } from "@marea/deepagents-adapter";

import { NoActiveRunError, TurnAttemptFailed, type TurnFailureInfo } from "./contracts.js";
import { StudentHttpError } from "./http-error.js";
import { RequiredSkillsError } from "./required-skill-context.js";

const MAX_CATEGORY = 128;
const MAX_NAME = 128;
const MAX_MESSAGE = 2_048;
const MAX_STACK = 8_192;
const MAX_CAUSES = 8;

interface DiagnosticException {
  readonly name: string;
  readonly message: string;
}

export interface TurnDiagnostic {
  readonly exception: DiagnosticException;
  readonly causes: readonly DiagnosticException[];
  readonly stack: string;
}

function failureCause(error: unknown): unknown {
  return error instanceof TurnAttemptFailed ? error.cause : error;
}

/** Each error on the cause chain, outermost first; cycle-safe and bounded. */
function chain(error: unknown): readonly unknown[] {
  const errors: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && !errors.includes(current) && errors.length <= MAX_CAUSES) {
    errors.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return errors;
}

function exception(value: unknown): DiagnosticException {
  if (value instanceof Error)
    return {
      name: value.name.slice(0, MAX_NAME) || "Error",
      message: value.message.slice(0, MAX_MESSAGE),
    };
  return { name: typeof value, message: String(value).slice(0, MAX_MESSAGE) };
}

/** Where a failure came from, so a category names its origin and not only its kind. */
function origin(error: unknown): string {
  const errors = chain(failureCause(error));
  const recognized = errors.findLast(
    (value) =>
      value instanceof ModelStreamError ||
      value instanceof StudentHttpError ||
      value instanceof NoActiveRunError,
  );
  if (recognized instanceof ModelStreamError) return `provider.${recognized.streamCode}`;
  if (recognized instanceof StudentHttpError) return `http.${recognized.code}`;
  if (recognized instanceof NoActiveRunError) return "session.no-active-run";
  const [top, next] = errors;
  if (top instanceof RequiredSkillsError) return "skills.required";
  if (top instanceof AgentAdapterError) {
    const cause =
      top.code === "upstream-execution-failed" && next instanceof Error ? `/${next.name}` : "";
    return `adapter.${top.code}${cause}`;
  }
  return `client.${exception(top).name}`;
}

/**
 * The `turn-failed` category: the kind the student sees plus the origin that explains it, for
 * example `unexpected/adapter.upstream-execution-failed/ZodError`. It never contains messages.
 */
export function failureCategory(error: unknown, failure: TurnFailureInfo): string {
  return `${failure.kind}/${origin(error)}`.slice(0, MAX_CATEGORY);
}

/** The technical detail of a failure: exception, cause chain and stack, bounded. */
export function failureDiagnostic(error: unknown): TurnDiagnostic {
  const [top, ...causes] = chain(failureCause(error));
  const deepest = [top, ...causes].findLast((value) => value instanceof Error);
  return {
    exception: exception(top),
    causes: causes.slice(0, MAX_CAUSES).map(exception),
    stack: (deepest instanceof Error ? (deepest.stack ?? "") : "").slice(0, MAX_STACK),
  };
}
