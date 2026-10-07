import {
  CLASS_CONFIGURATION_REQUIRED_HEADER,
  ProtocolVersionSchema,
  RequestIdSchema,
} from "@marea/protocol";
import { expect, it } from "vitest";
import { createHttpStudentServer } from "./http-client.boundary.js";

function json(value: object, status: number, headers: Record<string, string>): Response {
  return Response.json(value, { status, headers });
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
    const server = createHttpStudentServer({
      baseUrl: "https://teacher.test",
      fetch: () =>
        Promise.resolve(
          json(
            { error: { code, retryable: false } },
            409,
            hint === null ? {} : { [CLASS_CONFIGURATION_REQUIRED_HEADER]: hint },
          ),
        ),
    });
    await expect(
      server.capabilities({
        requestId: RequestIdSchema.parse("request:hint"),
        clientVersion: "0.1.0",
        supportedProtocolVersions: [ProtocolVersionSchema.parse("0.1")],
      }),
    ).rejects.toMatchObject({
      code,
      status: 409,
      retryable: false,
      classConfigurationRequired: expected,
    });
  },
);
