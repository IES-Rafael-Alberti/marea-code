export type StudentTuiStartupErrorCode = "NON_INTERACTIVE" | "RENDERER_FAILED";

const EXIT_CODES: Readonly<Record<StudentTuiStartupErrorCode, number>> = Object.freeze({
  NON_INTERACTIVE: 2,
  RENDERER_FAILED: 1,
});

export class StudentTuiStartupError extends Error {
  readonly code: StudentTuiStartupErrorCode;
  readonly exitCode: number;

  constructor(code: StudentTuiStartupErrorCode) {
    super(`Student TUI startup failed: ${code}`);
    this.name = "StudentTuiStartupError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
  }
}
