import {
  CLASS_CONFIGURATION_REQUIRED_HEADER,
  RUN_CLOSED_REASON_HEADER,
  type RequestId,
} from "@marea/protocol";
import {
  ClassConfigurationRequiredError,
  RunClosedError,
  TeacherDomainError,
} from "../identity/errors.js";
import { protocolError } from "./response.js";

/** The exception behind each generic 500, kept beside its response for the request log. */
const unhandledFailures = new WeakMap<
  Response,
  { readonly error: unknown; readonly requestId: RequestId }
>();

export function unhandledFailureOf(
  response: Response,
): { readonly error: unknown; readonly requestId: RequestId } | undefined {
  return unhandledFailures.get(response);
}

function domainError(error: unknown, requestId: RequestId): Response {
  if (!(error instanceof TeacherDomainError)) {
    const response = protocolError(500, "server.error", true, requestId);
    unhandledFailures.set(response, { error, requestId });
    return response;
  }
  if (error.code === "protocol.incompatible")
    return protocolError(409, "protocol.incompatible", false, requestId);
  if (error.code === "auth.busy") {
    return protocolError(503, "server.error", true, requestId);
  }
  if (error.code === "auth.invalid") {
    return protocolError(401, "auth.invalid", false, requestId);
  }
  if (error.code === "run.unavailable") {
    const response = protocolError(409, "run.unavailable", false, requestId);
    if (error instanceof ClassConfigurationRequiredError)
      response.headers.set(CLASS_CONFIGURATION_REQUIRED_HEADER, "true");
    if (error instanceof RunClosedError)
      response.headers.set(RUN_CLOSED_REASON_HEADER, error.reason);
    return response;
  }
  return protocolError(
    error.code === "dashboard.forbidden" ? 403 : 409,
    "request.invalid",
    false,
    requestId,
  );
}
export async function safeOperation(
  requestId: RequestId,
  operation: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    return await operation();
  } catch (error: unknown) {
    return domainError(error, requestId);
  }
}
