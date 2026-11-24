import {
  CLASS_CONFIGURATION_REQUIRED_HEADER,
  ProtocolVersionSchema,
  RequestIdSchema,
  RUN_CLOSED_REASON_HEADER,
} from "@marea/protocol";
import { expect, it } from "vitest";
import { createHttpStudentServer } from "./http-client.boundary.js";

function json(value: object, status: number, headers: Record<string, string>): Response {
  return Response.json(value, { status, headers });
}

function refusal(code: string, header: string, hint: string | null) {
  const server = createHttpStudentServer({
    baseUrl: "https://teacher.test",
    fetch: () =>
      Promise.resolve(
        json({ error: { code, retryable: false } }, 409, hint === null ? {} : { [header]: hint }),
      ),
  });
  return expect(
    server.capabilities({
      requestId: RequestIdSchema.parse("request:hint"),
      clientVersion: "0.1.0",
      supportedProtocolVersions: [ProtocolVersionSchema.parse("0.1")],
    }),
  ).rejects;
}

it.each([
  ["run.unavailable", "true", true],
  ["run.unavailable", "false", false],
  ["run.unavailable", "private-untrusted-value", false],
  ["run.unavailable", null, false],
  ["server.error", "true", false],
] as const)(
  "reads a class configuration hint only on the matching error: %s %s",
  async (code, hint, expected) => {
    await refusal(code, CLASS_CONFIGURATION_REQUIRED_HEADER, hint).toMatchObject({
      code,
      status: 409,
      retryable: false,
      classConfigurationRequired: expected,
    });
  },
);

it.each([
  ["run.unavailable", "teacher-ended", "teacher-ended"],
  ["run.unavailable", "class-ended", "class-ended"],
  ["run.unavailable", "session-expired", "session-expired"],
  ["run.unavailable", "student-exit", undefined],
  ["run.unavailable", "private-untrusted-value", undefined],
  ["run.unavailable", null, undefined],
  ["server.error", "teacher-ended", undefined],
] as const)(
  "reads why the server closed a run only from a run.unavailable refusal: %s %s",
  async (code, hint, expected) => {
    await refusal(code, RUN_CLOSED_REASON_HEADER, hint).toMatchObject({
      code,
      status: 409,
      runClosedReason: expected,
    });
  },
);
