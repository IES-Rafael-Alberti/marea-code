import type { ServerCloseReason } from "@marea/protocol";

export type TeacherDomainErrorCode =
  | "protocol.incompatible"
  | "auth.busy"
  | "auth.invalid"
  | "dashboard.forbidden"
  | "invitation.unavailable"
  | "request.conflict"
  | "run.unavailable";

export class TeacherDomainError extends Error {
  public readonly code: TeacherDomainErrorCode;

  public constructor(code: TeacherDomainErrorCode) {
    super(code);
    this.name = "TeacherDomainError";
    this.code = code;
  }
}

export class ClassConfigurationRequiredError extends TeacherDomainError {
  constructor() {
    super("run.unavailable");
  }
}

/** The run exists but the server itself closed it; clients may explain why it is unavailable. */
export class RunClosedError extends TeacherDomainError {
  public readonly reason: ServerCloseReason;

  constructor(reason: ServerCloseReason) {
    super("run.unavailable");
    this.reason = reason;
  }
}
