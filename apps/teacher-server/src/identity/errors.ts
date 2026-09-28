export type TeacherDomainErrorCode =
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
