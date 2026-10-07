import type { MessageKey, Translator } from "@marea/i18n";
import { StudentTuiStartupError } from "@marea/student-tui";
import { ZodError } from "zod";

import { StudentHttpError } from "./http-error.js";

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
    code += `/HTTP-${String(error.status)}`;
  } else if (error instanceof StudentTuiStartupError) {
    key =
      error.code === "NON_INTERACTIVE"
        ? "student.cli.terminal-required"
        : "student.cli.renderer-failed";
    code = error.code;
  } else if (error instanceof ZodError) {
    key = "student.cli.local-state-invalid";
    code = "local-state-invalid";
  }
  return `${translator.t(key)}\n${translator.t("student.cli.failure-code", { code: `${stage}/${code}` })}\n`;
}
