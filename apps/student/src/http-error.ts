import {
  CLASS_CONFIGURATION_REQUIRED_HEADER,
  RUN_CLOSED_REASON_HEADER,
  ServerCloseReasonSchema,
  type ServerCloseReason,
} from "@marea/protocol";

export class StudentHttpError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  constructor(
    status: number,
    code: string,
    retryable: boolean,
    readonly classConfigurationRequired = false,
    /** Why the server closed the run, when it said so; older servers never do. */
    readonly runClosedReason?: ServerCloseReason | undefined,
  ) {
    super("The Marea teacher server rejected the request.");
    this.name = "StudentHttpError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Reads the optional run.unavailable hints; older servers send neither. */
export function httpErrorFromResponse(
  status: number,
  error: { readonly code: string; readonly retryable: boolean },
  headers: Headers,
): StudentHttpError {
  const unavailable = error.code === "run.unavailable";
  return new StudentHttpError(
    status,
    error.code,
    error.retryable,
    unavailable && headers.get(CLASS_CONFIGURATION_REQUIRED_HEADER) === "true",
    unavailable
      ? ServerCloseReasonSchema.safeParse(headers.get(RUN_CLOSED_REASON_HEADER)).data
      : undefined,
  );
}
