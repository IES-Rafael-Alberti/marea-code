import type { MessageKey, Translator } from "@marea/i18n";
import { StudentTuiStartupError } from "@marea/student-tui";
import { ZodError } from "zod";

import { StudentHttpError } from "./http-error.js";
import { studentHttpTransportDiagnostics } from "./http-transport-diagnostics.boundary.js";

const DIAGNOSTIC_CODE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAX_DIAGNOSTIC_DEPTH = 3;

function errorProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function findDiagnosticCode(error: unknown, includeCheckpoint: boolean): string | null {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < MAX_DIAGNOSTIC_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    const candidate = errorProperty(current, "diagnosticCode");
    if (typeof candidate === "string" && DIAGNOSTIC_CODE.test(candidate)) return candidate;
    if (
      includeCheckpoint &&
      errorProperty(current, "name") === "AgentAdapterError" &&
      errorProperty(current, "code") === "invalid-checkpoint-state"
    ) {
      return "checkpoint.invalid";
    }
    current = errorProperty(current, "cause");
  }
  return null;
}

/** Shared, read-only diagnostic contract used by startup and turn boundaries. */
export function diagnosticCodeFor(error: unknown): string | null {
  return findDiagnosticCode(error, false);
}

function startupDiagnosticCode(error: unknown): string | null {
  return findDiagnosticCode(error, true);
}

function printableServerOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export class StudentWorkspaceError extends Error {
  constructor(
    readonly key: "student.git.missing" | "student.git.not-root" | "student.git.cancelled",
    translator: Translator,
  ) {
    super(translator.t(key));
  }
}

const HTTP_MESSAGES: ReadonlyMap<string, MessageKey> = new Map([
  ["auth.invalid", "errors.auth.invalid"],
  ["protocol.incompatible", "errors.protocol.incompatible"],
  ["request.invalid", "errors.request.invalid"],
  ["run.unavailable", "student.cli.run-unavailable"],
  ["server.error", "errors.server.error"],
  ["transport.unavailable", "bootstrap.connection-failed"],
  ["transport.interrupted", "bootstrap.connection-failed"],
  ["request.cancelled", "student.cli.connection-timeout"],
  ["response.invalid", "student.cli.response-invalid"],
  ["response.too-large", "student.cli.response-invalid"],
]);

/** Only allowlisted codes and our own copy are printable; errors can contain credentials. */
export function startupFailure(error: unknown, translator: Translator, stage: string): string {
  let key: MessageKey = "student.cli.unexpected-error";
  let code = "unexpected";
  let serverOrigin: string | null = null;
  if (error instanceof StudentWorkspaceError) {
    key = error.key;
    code = key;
  } else if (error instanceof StudentHttpError) {
    const message = HTTP_MESSAGES.get(error.code);
    if (message !== undefined) {
      key = message;
      code = error.code;
    }
    if (error.classConfigurationRequired) {
      key = "student.cli.class-configuration-required";
      code = "class-configuration-required";
    }
    const transport =
      error.code === "transport.unavailable" || error.code === "transport.interrupted"
        ? studentHttpTransportDiagnostics(error)
        : null;
    if (transport === null) {
      code += `/HTTP-${String(error.status)}`;
    } else {
      serverOrigin = printableServerOrigin(transport.serverOrigin);
      code = `${error.code}/HTTP-0/${transport.endpoint.slice(1)}/${transport.cause.name}:${transport.cause.code}`;
    }
  } else if (error instanceof StudentTuiStartupError) {
    key =
      error.code === "NON_INTERACTIVE"
        ? "student.cli.terminal-required"
        : "student.cli.renderer-failed";
    code = error.code;
  } else if (error instanceof ZodError) {
    key = "student.cli.local-state-invalid";
    code = "local-state-invalid";
  } else {
    code = startupDiagnosticCode(error) ?? code;
  }
  const message =
    serverOrigin === null
      ? translator.t(key)
      : translator.t("bootstrap.connection-failed-at", { origin: serverOrigin });
  return `${message}\n${translator.t("student.cli.failure-code", { code: `${stage}/${code}` })}\n`;
}
