import { StudentHttpError } from "./http-error.js";

const MAX_TRANSPORT_CAUSE_DEPTH = 5;
const TRANSPORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "DOMException",
  "Error",
  "FetchError",
  "NetworkError",
  "SystemError",
  "TimeoutError",
  "TypeError",
]);
const TRANSPORT_SYSTEM_CODES: ReadonlySet<string> = new Set([
  "ABORT_ERR",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_SOCKET_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "redirect-rejected",
]);

interface StudentHttpTransportCause {
  readonly name: string;
  readonly code: string;
}

export interface StudentHttpTransportDiagnostics {
  readonly cause: StudentHttpTransportCause;
  readonly elapsedMs: number;
  readonly endpoint: string;
  readonly serverOrigin: string;
}

/** Safe transport context attached only after a fetch or body stream rejects. */
export type StudentHttpTransportError = StudentHttpError & StudentHttpTransportDiagnostics;

function objectProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function allowlistedTransportCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  if (TRANSPORT_SYSTEM_CODES.has(value)) return value;
  return /^(?:CERT_[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+|TLS_[A-Z0-9_]+)$/u.test(value) ? value : null;
}

/** Convert an arbitrary rejection to a small value that cannot carry request secrets. */
function transportCause(error: unknown): StudentHttpTransportCause {
  let current = error;
  let name = "other";
  let code: string | null = null;
  let redirected = false;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < MAX_TRANSPORT_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    if (name === "other") {
      const candidate = objectProperty(current, "name");
      if (typeof candidate === "string" && TRANSPORT_ERROR_NAMES.has(candidate)) {
        name = candidate;
      }
    }
    code ??= allowlistedTransportCode(objectProperty(current, "code"));
    const message = objectProperty(current, "message");
    if (typeof message === "string" && /\bredirect\b/iu.test(message.slice(0, 256))) {
      redirected = true;
    }
    current = objectProperty(current, "cause");
  }
  return Object.freeze({ name, code: code ?? (redirected ? "redirect-rejected" : "other") });
}

export function transportFailure(
  request: Request,
  error: unknown,
  startedAt: number,
  interrupted: boolean,
): StudentHttpTransportError {
  const cancelled = request.signal.aborted;
  const failure = new StudentHttpError(
    0,
    cancelled
      ? "request.cancelled"
      : interrupted
        ? "transport.interrupted"
        : "transport.unavailable",
    !cancelled,
  );
  const url = new URL(request.url);
  // Non-enumerable fields preserve the existing error shape while remaining readable at boundaries.
  Object.defineProperties(failure, {
    cause: { value: transportCause(error) },
    elapsedMs: { value: Math.max(0, Math.round(performance.now() - startedAt)) },
    endpoint: { value: url.pathname },
    serverOrigin: { value: url.origin },
  });
  return failure as StudentHttpTransportError;
}

function diagnosticEndpoint(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 256 ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\")
  ) {
    return null;
  }
  return value;
}

/** Revalidates attached fields before any value crosses into printable diagnostics. */
export function studentHttpTransportDiagnostics(
  error: StudentHttpError,
): StudentHttpTransportDiagnostics | null {
  const endpoint = diagnosticEndpoint(objectProperty(error, "endpoint"));
  const elapsedMs = objectProperty(error, "elapsedMs");
  const serverOrigin = objectProperty(error, "serverOrigin");
  if (
    endpoint === null ||
    typeof elapsedMs !== "number" ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    typeof serverOrigin !== "string"
  ) {
    return null;
  }
  return {
    cause: transportCause(objectProperty(error, "cause")),
    elapsedMs,
    endpoint,
    serverOrigin,
  };
}
