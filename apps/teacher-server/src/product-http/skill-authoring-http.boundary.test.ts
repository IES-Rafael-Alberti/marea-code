import {
  MAX_SKILL_RESPONSE_BYTES,
  ProtocolErrorResponseSchema,
  RequestIdSchema,
  SkillAuthoringReadResponseSchema,
} from "@marea/protocol";
import * as z from "zod";

import { BundledSkillError } from "../teaching/skills/errors.js";
import { SkillAuthoringError } from "../teaching/authoring/errors.js";
import { TeacherDomainError } from "../identity/errors.js";
import { SkillAuthoringServiceError } from "../teaching/authoring-runtime/skill-authoring-service.js";
import {
  TEACHER_COOKIE,
  bodyRequest,
  createRouteApp,
  validReadRequest,
  validSaveRequest,
} from "./skill-authoring-http.fixture.js";
import {
  authoringErrorResponse,
  boundedSkillAuthoringJson,
} from "./skill-authoring-http.boundary.js";
import { describe, expect, it } from "vitest";

const cookie = `marea_teacher_session=${TEACHER_COOKIE}`;
const origin = "https://dashboard.test";
interface ResponseSummary {
  readonly kind: string;
  readonly requestId: string;
}

async function protocolErrorSummary(response: Response): Promise<{
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;
}> {
  const body = ProtocolErrorResponseSchema.parse(await response.json());
  const summary = {
    code: body.error.code,
    retryable: body.error.retryable,
    status: response.status,
  };
  return body.requestId === undefined ? summary : { ...summary, requestId: body.requestId };
}

describe("skill authoring HTTP boundary", () => {
  it("registers read, validate, save, and copy with correlated strict responses", async () => {
    const { app } = createRouteApp();
    const responses = await Promise.all([
      app.fetch(
        bodyRequest("/api/v1/dashboard/skill-authoring/read", JSON.stringify(validReadRequest()), {
          cookie,
        }),
      ),
      app.fetch(
        bodyRequest(
          "/api/v1/dashboard/skill-authoring/validate",
          JSON.stringify({
            classId: "class:physics",
            draft: validSaveRequest.draft,
            kind: "skill-authoring-validate",
            protocolVersion: "0.1",
            requestId: "request:validate",
          }),
          { cookie, origin },
        ),
      ),
      app.fetch(
        bodyRequest("/api/v1/dashboard/skill-authoring/save", JSON.stringify(validSaveRequest), {
          cookie,
          origin,
        }),
      ),
      app.fetch(
        bodyRequest(
          "/api/v1/dashboard/skill-authoring/copy",
          JSON.stringify({
            classId: "class:physics",
            kind: "skill-authoring-copy",
            protocolVersion: "0.1",
            requestId: "request:copy",
            slug: "copied",
            sourceDigest: `sha256:${"d".repeat(64)}`,
            sourceSkillId: "marea/practice",
          }),
          { cookie, origin },
        ),
      ),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    const bodies: ResponseSummary[] = await Promise.all(
      responses.map(async (response) => (await response.json()) as ResponseSummary),
    );
    expect(bodies.map((body) => body.kind)).toEqual([
      "skill-authoring-read-result",
      "skill-authoring-validated",
      "skill-authoring-saved",
      "skill-authoring-copied",
    ]);
    expect(bodies.map((body) => body.requestId)).toEqual([
      "request:read",
      "request:validate",
      "request:save",
      "request:copy",
    ]);
  });

  it("applies teacher authentication and origin policy by operation", async () => {
    const { app } = createRouteApp();
    const readWithoutCookie = await app.fetch(
      bodyRequest("/api/v1/dashboard/skill-authoring/read", JSON.stringify(validReadRequest())),
    );
    const saveWithoutOrigin = await app.fetch(
      bodyRequest("/api/v1/dashboard/skill-authoring/save", JSON.stringify(validSaveRequest), {
        cookie,
      }),
    );
    const validateWithoutOrigin = await app.fetch(
      bodyRequest(
        "/api/v1/dashboard/skill-authoring/validate",
        JSON.stringify({
          classId: "class:physics",
          draft: validSaveRequest.draft,
          kind: "skill-authoring-validate",
          protocolVersion: "0.1",
          requestId: "request:validate-origin",
        }),
        { cookie },
      ),
    );
    const readWithOrigin = await app.fetch(
      bodyRequest("/api/v1/dashboard/skill-authoring/read", JSON.stringify(validReadRequest()), {
        cookie,
        origin,
      }),
    );
    expect(readWithoutCookie.status).toBe(401);
    expect(saveWithoutOrigin.status).toBe(403);
    expect(validateWithoutOrigin.status).toBe(403);
    expect(readWithOrigin.status).toBe(200);
  });

  it("rejects media, schema, encoding, length, and transport-bound violations", async () => {
    const { app } = createRouteApp();
    const missingMedia = bodyRequest(
      "/api/v1/dashboard/skill-authoring/read",
      JSON.stringify(validReadRequest()),
      { cookie },
    );
    missingMedia.headers.delete("content-type");
    const invalidSchema = bodyRequest(
      "/api/v1/dashboard/skill-authoring/read",
      JSON.stringify({ ...validReadRequest(), extra: true }),
      { cookie },
    );
    const invalidJson = bodyRequest("/api/v1/dashboard/skill-authoring/read", "{", { cookie });
    const tooLargeHeader = bodyRequest("/api/v1/dashboard/skill-authoring/read", "{}", {
      contentLength: "70000",
    });
    const tooLargeBody = bodyRequest(
      "/api/v1/dashboard/skill-authoring/read",
      "x".repeat(65 * 1_024),
    );
    const invalidLength = bodyRequest("/api/v1/dashboard/skill-authoring/read", "{}", {
      contentLength: "not-a-number",
    });
    const unsafeLength = bodyRequest("/api/v1/dashboard/skill-authoring/read", "{}", {
      contentLength: "999999999999999999999999",
    });
    const mismatchedLength = bodyRequest("/api/v1/dashboard/skill-authoring/read", "{}", {
      contentLength: "1",
    });
    const emptyWithZeroLength = bodyRequest("/api/v1/dashboard/skill-authoring/read", null, {
      contentLength: "0",
    });
    const emptyWithWrongLength = bodyRequest("/api/v1/dashboard/skill-authoring/read", null, {
      contentLength: "1",
    });
    await expect(protocolErrorSummary(await app.fetch(missingMedia))).resolves.toMatchObject({
      code: "request.invalid",
      retryable: false,
      status: 415,
    });
    for (const response of [
      invalidSchema,
      invalidJson,
      invalidLength,
      mismatchedLength,
      emptyWithZeroLength,
      emptyWithWrongLength,
    ]) {
      await expect(protocolErrorSummary(await app.fetch(response))).resolves.toMatchObject({
        code: "request.invalid",
        retryable: false,
        status: 400,
      });
    }
    for (const response of [tooLargeHeader, tooLargeBody, unsafeLength]) {
      await expect(protocolErrorSummary(await app.fetch(response))).resolves.toMatchObject({
        code: "request.invalid",
        retryable: false,
        status: 413,
      });
    }
    for (const [value, expected] of [
      ["junk1", 400],
      ["1junk", 400],
    ] as const) {
      const response = await app.fetch(
        bodyRequest("/api/v1/dashboard/skill-authoring/read", "{}", {
          contentLength: value,
          cookie,
        }),
      );
      await expect(protocolErrorSummary(response)).resolves.toMatchObject({
        code: "request.invalid",
        retryable: false,
        status: expected,
      });
    }

    const malformed = bodyRequest(
      "/api/v1/dashboard/skill-authoring/read",
      new Uint8Array([0xc3, 0x28]),
      { cookie },
    );
    const incomplete = bodyRequest(
      "/api/v1/dashboard/skill-authoring/read",
      new Uint8Array([0xc3]),
      { cookie },
    );
    await expect(protocolErrorSummary(await app.fetch(malformed))).resolves.toMatchObject({
      code: "request.invalid",
      retryable: false,
      status: 400,
    });
    await expect(protocolErrorSummary(await app.fetch(incomplete))).resolves.toMatchObject({
      code: "request.invalid",
      retryable: false,
      status: 400,
    });
  });

  it("maps domain failures to sanitized status and retry semantics", async () => {
    const requestId = RequestIdSchema.parse("request:error");
    const cases = [
      [new TeacherDomainError("auth.invalid"), 401, "auth.invalid", false],
      [new TeacherDomainError("dashboard.forbidden"), 403, "request.invalid", false],
      [
        new SkillAuthoringError("SKILL_EXISTS", "private/path", "private"),
        409,
        "request.invalid",
        false,
      ],
      [
        new SkillAuthoringError("STALE_SKILL_DIGEST", "private/path", "private"),
        409,
        "request.invalid",
        false,
      ],
      [
        new SkillAuthoringError("SKILL_MISSING", "private/path", "private"),
        422,
        "request.invalid",
        false,
      ],
      [
        new SkillAuthoringError("UNSAFE_AUTHORING_INPUT", "private/path", "private"),
        400,
        "request.invalid",
        false,
      ],
      [
        new SkillAuthoringError("AUTHORING_LIMIT", "private/path", "private"),
        413,
        "request.invalid",
        false,
      ],
      [
        new SkillAuthoringError("AUTHORING_WRITE_FAILED", "private/path", "private"),
        500,
        "server.error",
        true,
      ],
      [
        new BundledSkillError("READ_FAILED", "private/path", "private"),
        422,
        "request.invalid",
        false,
      ],
      [new SkillAuthoringServiceError("source-unavailable"), 422, "request.invalid", false],
      [new Error("private failure"), 500, "server.error", true],
    ] as const;
    for (const [error, status, code, retryable] of cases) {
      await expect(protocolErrorSummary(authoringErrorResponse(error, requestId))).resolves.toEqual(
        {
          code,
          requestId: "request:error",
          retryable,
          status,
        },
      );
    }
  });

  it("sanitizes operation and response failures and enforces response bounds", async () => {
    const paths = [
      "/api/v1/dashboard/skill-authoring/read",
      "/api/v1/dashboard/skill-authoring/validate",
      "/api/v1/dashboard/skill-authoring/save",
      "/api/v1/dashboard/skill-authoring/copy",
    ] as const;
    for (const path of paths) {
      const { app } = createRouteApp({
        read: () => Promise.reject(new Error("private operation failure")),
        validate: () => Promise.reject(new Error("private operation failure")),
        save: () => Promise.reject(new Error("private operation failure")),
        copy: () => Promise.reject(new Error("private operation failure")),
      });
      const body = path.endsWith("/read")
        ? validReadRequest()
        : path.endsWith("/copy")
          ? {
              classId: "class:physics",
              kind: "skill-authoring-copy",
              protocolVersion: "0.1",
              requestId: "request:copy-error",
              slug: "copied",
              sourceDigest: `sha256:${"d".repeat(64)}`,
              sourceSkillId: "marea/practice",
            }
          : path.endsWith("/validate")
            ? {
                classId: "class:physics",
                draft: validSaveRequest.draft,
                kind: "skill-authoring-validate",
                protocolVersion: "0.1",
                requestId: "request:validate-error",
              }
            : validSaveRequest;
      const response = await app.fetch(bodyRequest(path, JSON.stringify(body), { cookie, origin }));
      await expect(protocolErrorSummary(response)).resolves.toMatchObject({
        code: "server.error",
        retryable: true,
        status: 500,
      });
    }

    const { app } = createRouteApp({
      read: () => Promise.resolve({ invalid: true } as never),
    });
    const invalidResponse = await app.fetch(
      bodyRequest("/api/v1/dashboard/skill-authoring/read", JSON.stringify(validReadRequest()), {
        cookie,
      }),
    );
    await expect(protocolErrorSummary(invalidResponse)).resolves.toMatchObject({
      code: "server.error",
      retryable: true,
      status: 500,
    });

    const smallSchema = z.object({ payload: z.string() });
    const bounded = boundedSkillAuthoringJson(
      smallSchema,
      { payload: "too large" },
      RequestIdSchema.parse("request:bound"),
      1,
    );
    await expect(protocolErrorSummary(bounded)).resolves.toMatchObject({
      code: "server.error",
      retryable: true,
      status: 500,
    });
    const exactPayload = { payload: "x" };
    const exactBytes = new TextEncoder().encode(JSON.stringify(exactPayload)).byteLength;
    expect(
      boundedSkillAuthoringJson(
        smallSchema,
        exactPayload,
        RequestIdSchema.parse("request:bound-exact"),
        exactBytes,
      ).status,
    ).toBe(200);
    expect(
      boundedSkillAuthoringJson(
        smallSchema,
        { payload: "ok" },
        RequestIdSchema.parse("request:bound-ok"),
        MAX_SKILL_RESPONSE_BYTES,
      ).status,
    ).toBe(200);
    expect(() =>
      boundedSkillAuthoringJson(
        SkillAuthoringReadResponseSchema,
        {},
        RequestIdSchema.parse("request:bad-response"),
      ),
    ).toThrow();
  });
});
