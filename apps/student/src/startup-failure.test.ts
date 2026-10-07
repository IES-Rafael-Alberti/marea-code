import { createTranslator } from "@marea/i18n";
import { StudentTuiStartupError } from "@marea/student-tui";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { StudentHttpError } from "./http-error.js";
import { startupFailure, StudentWorkspaceError } from "./startup-failure.boundary.js";

const translator = createTranslator("en");

describe("safe startup diagnostics", () => {
  it.each([
    ["auth.invalid", "Authentication failed"],
    ["protocol.incompatible", "not compatible"],
    ["request.invalid", "could not be understood"],
    ["run.unavailable", "class configuration has been saved"],
    ["server.error", "could not complete the request"],
    ["transport.unavailable", "Could not connect"],
    ["transport.interrupted", "Could not connect"],
    ["request.cancelled", "did not respond in time"],
    ["response.invalid", "cannot read"],
    ["response.too-large", "cannot read"],
  ])("explains %s and includes a shareable code", (code, message) => {
    const result = startupFailure(new StudentHttpError(409, code, false), translator, "session");
    expect(result).toContain(message);
    expect(result).toContain(`Diagnostic code: session/${code}/HTTP-409.`);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("explains the teacher action when configuration is missing", () => {
    const result = startupFailure(
      new StudentHttpError(409, "run.unavailable", false, true),
      createTranslator("es"),
      "session",
    );
    expect(result).toContain("Ajustes → Esta clase");
    expect(result).toContain("no necesitas reinstalar ni borrar tu sesión");
    expect(result).toContain("session/class-configuration-required/HTTP-409");
  });

  it.each(["student.git.missing", "student.git.not-root", "student.git.cancelled"] as const)(
    "keeps actionable workspace copy for %s",
    (key) => {
      const error = new StudentWorkspaceError(key, translator);
      expect(error.message).toBe(translator.t(key));
      const result = startupFailure(error, translator, "workspace");
      expect(result).toContain(translator.t(key));
      expect(result).toContain(`workspace/${key}`);
    },
  );

  it.each([
    ["NON_INTERACTIVE", "interactive terminal"],
    ["RENDERER_FAILED", "Try another terminal"],
  ] as const)("explains terminal failure %s", (code, message) => {
    const result = startupFailure(new StudentTuiStartupError(code), translator, "interface");
    expect(result).toContain(message);
    expect(result).toContain(`interface/${code}`);
  });

  it("reports invalid local data without showing its contents", () => {
    const parsed = z.literal("expected").safeParse("synthetic-private-data");
    const result = startupFailure(parsed.error, translator, "local-state");
    expect(result).toContain("Keep the data");
    expect(result).toContain("local-state/local-state-invalid");
    expect(result).not.toContain("synthetic-private-data");
  });

  it.each([
    new Error("synthetic-secret"),
    "synthetic-secret",
    null,
    new StudentHttpError(502, "synthetic-secret", false),
  ])("does not print arbitrary error details: %#", (error) => {
    const result = startupFailure(error, translator, "session");
    expect(result).toContain("Marea could not start");
    expect(result).toContain("session/unexpected");
    expect(result).not.toContain("synthetic-secret");
  });
});
