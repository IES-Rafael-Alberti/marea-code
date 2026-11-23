import { createTranslator } from "@marea/i18n";
import { StudentTuiStartupError } from "@marea/student-tui";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { StudentHttpError } from "./http-error.js";
import { startupFailure, StudentWorkspaceError } from "./startup-failure.boundary.js";

const translator = createTranslator("en");

function transportFailure(serverOrigin: string): StudentHttpError {
  const error = new StudentHttpError(0, "transport.unavailable", true);
  Object.defineProperties(error, {
    cause: { value: { name: "TypeError", code: "ECONNREFUSED" } },
    elapsedMs: { value: 42 },
    endpoint: { value: "/v1/capabilities" },
    serverOrigin: { value: serverOrigin },
  });
  return error;
}

function wrappedDiagnostic(depth: number, diagnosticCode: string | number | null): Error {
  let error: Error = Object.assign(new Error("private cause details"), { diagnosticCode });
  for (let index = 0; index < depth; index += 1) {
    error = new Error("private wrapper details", { cause: error });
  }
  return error;
}

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

  it("shows the sanitized origin and allowlisted transport cause", () => {
    const result = startupFailure(
      transportFailure(
        "https://student:secret@teacher.example:8443/private/path?token=secret#fragment",
      ),
      translator,
      "capabilities",
    );
    expect(result).toContain(
      "Could not connect to the teacher server at https://teacher.example:8443",
    );
    expect(result).toContain(
      "capabilities/transport.unavailable/HTTP-0/v1/capabilities/TypeError:ECONNREFUSED",
    );
    expect(result).not.toContain("student:secret");
    expect(result).not.toContain("private/path");
    expect(result).not.toContain("token=secret");
  });

  it.each(["private-fs.timeout", "checkpoint.invalid", "local-state.disk-0"])(
    "prints a valid diagnostic code %s without printing error details",
    (diagnosticCode) => {
      const result = startupFailure(
        wrappedDiagnostic(0, diagnosticCode),
        translator,
        "local-state",
      );
      expect(result).toContain(`local-state/${diagnosticCode}`);
      expect(result).not.toContain("private cause details");
    },
  );

  it("finds diagnostic codes through three error levels and ignores deeper causes", () => {
    expect(
      startupFailure(wrappedDiagnostic(2, "private-fs.timeout"), translator, "local-state"),
    ).toContain("local-state/private-fs.timeout");
    expect(
      startupFailure(wrappedDiagnostic(3, "private-fs.timeout"), translator, "local-state"),
    ).toContain("local-state/unexpected");
    expect(
      startupFailure(wrappedDiagnostic(3, "private-fs.timeout"), translator, "local-state"),
    ).not.toContain("private-fs.timeout");
  });

  it.each(["Private-FS.Timeout", "private fs", "/private", "private..fs", "private_fs", ""])(
    "ignores the invalid diagnostic code %#",
    (diagnosticCode) => {
      const result = startupFailure(
        wrappedDiagnostic(0, diagnosticCode),
        translator,
        "local-state",
      );
      expect(result).toContain("local-state/unexpected");
      if (diagnosticCode !== "") expect(result).not.toContain(diagnosticCode);
    },
  );

  it("continues past an invalid wrapper code to a valid nested code", () => {
    const inner = wrappedDiagnostic(0, "private-fs.timeout");
    const outer = Object.assign(new Error("private wrapper", { cause: inner }), {
      diagnosticCode: "PRIVATE/SECRET",
    });
    const result = startupFailure(outer, translator, "local-state");
    expect(result).toContain("local-state/private-fs.timeout");
    expect(result).not.toContain("PRIVATE/SECRET");
  });

  it("maps checkpoint corruption structurally without exposing checkpoint contents", () => {
    const error = Object.assign(new Error("private checkpoint contents"), {
      code: "invalid-checkpoint-state",
      name: "AgentAdapterError",
    });
    const result = startupFailure(error, translator, "local-state");
    expect(result).toContain("local-state/checkpoint.invalid");
    expect(result).not.toContain("private checkpoint contents");
  });

  it("terminates diagnostic discovery on a cyclic cause chain", () => {
    const error = new Error("private cycle");
    error.cause = error;
    expect(startupFailure(error, translator, "local-state")).toContain("local-state/unexpected");
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
