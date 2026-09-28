export class StudentHttpError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  constructor(status: number, code: string, retryable: boolean) {
    super("The Marea teacher server rejected the request.");
    this.name = "StudentHttpError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}
