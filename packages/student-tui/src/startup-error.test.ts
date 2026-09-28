import { describe, expect, it } from "vitest";

import { StudentTuiStartupError } from "./startup-error.js";

describe("StudentTuiStartupError", () => {
  it.each([
    ["NON_INTERACTIVE", 2],
    ["RENDERER_FAILED", 1],
  ] as const)("exposes safe %s details", (code, exitCode) => {
    const error = new StudentTuiStartupError(code);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StudentTuiStartupError");
    expect(error.code).toBe(code);
    expect(error.exitCode).toBe(exitCode);
    expect(error.message).toBe(`Student TUI startup failed: ${code}`);
  });
});
