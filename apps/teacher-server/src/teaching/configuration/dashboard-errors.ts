import type { RequestId } from "@marea/protocol";

import { TeacherDomainError } from "../../identity/errors.js";
import { protocolError } from "../../product-http/response.js";

/** Operator prerequisites and selected skills fail closed without leaking details. */
export type TeachingConfigurationErrorCode =
  "invalid-request" | "operator-unconfigured" | "skill-unavailable";

export class TeachingConfigurationError extends Error {
  constructor(readonly code: TeachingConfigurationErrorCode) {
    super(`Teaching configuration request failed: ${code}.`);
    this.name = "TeachingConfigurationError";
  }
}

/** Maps known failures to the shared protocol envelope; messages never reach clients. */
export function teachingConfigurationError(
  error: TeachingConfigurationError | TeacherDomainError,
  requestId: RequestId,
): ReturnType<typeof protocolError> {
  if (error instanceof TeacherDomainError) {
    if (error.code === "auth.invalid") return protocolError(401, "auth.invalid", false, requestId);
    if (error.code === "dashboard.forbidden") {
      return protocolError(403, "request.invalid", false, requestId);
    }
    if (error.code === "request.conflict") {
      return protocolError(409, "request.invalid", false, requestId);
    }
    return protocolError(409, "run.unavailable", false, requestId);
  }
  if (error.code === "invalid-request") {
    return protocolError(400, "request.invalid", false, requestId);
  }
  return error.code === "operator-unconfigured"
    ? protocolError(503, "server.error", false, requestId)
    : protocolError(422, "request.invalid", false, requestId);
}
