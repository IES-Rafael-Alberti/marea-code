export type OperatorConfigurationErrorCode =
  | "access-denied"
  | "changed-file"
  | "duplicate-class-id"
  | "invalid-bound"
  | "invalid-document"
  | "invalid-path"
  | "io-failure"
  | "not-found"
  | "not-regular-file"
  | "symlink"
  | "too-large";

export class OperatorConfigurationError extends Error {
  readonly code: OperatorConfigurationErrorCode;

  constructor(code: OperatorConfigurationErrorCode, message: string) {
    super(message);
    this.name = "OperatorConfigurationError";
    this.code = code;
  }
}
