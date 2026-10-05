/* eslint-disable @typescript-eslint/require-await */
import {
  ClassBootstrapRequestSchema,
  ClassSelectRequestSchema,
  ExternalAuthBeginRequestSchema,
  ExternalAuthCompleteRequestSchema,
  ExternalAuthProvidersRequestSchema,
  SessionTokenSchema,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import {
  STUDENT_HTTP_PATHS,
  StudentHttpError,
  createHttpStudentServer,
  type StudentFetch,
  type StudentHttpPaths,
} from "./http-client.boundary.js";

const token = SessionTokenSchema.parse("s".repeat(32));
const envelope = { protocolVersion: "0.1" } as const;
const requests = {
  bootstrap: ClassBootstrapRequestSchema.parse({
    ...envelope,
    kind: "class-bootstrap",
    requestId: "r:bootstrap",
  }),
  select: ClassSelectRequestSchema.parse({
    ...envelope,
    kind: "class-select",
    requestId: "r:select",
    classId: "class:two",
  }),
  providers: ExternalAuthProvidersRequestSchema.parse({
    ...envelope,
    kind: "external-auth-providers-query",
    requestId: "r:providers",
  }),
  begin: ExternalAuthBeginRequestSchema.parse({
    ...envelope,
    kind: "external-auth-begin",
    requestId: "r:begin",
    providerId: "org.example.idp",
    redirectUri: "http://127.0.0.1:4321/callback",
  }),
  complete: ExternalAuthCompleteRequestSchema.parse({
    ...envelope,
    kind: "external-auth-complete",
    requestId: "r:complete",
    flowId: "f".repeat(32),
    state: "s".repeat(32),
    code: "4/code",
  }),
};

function json(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

const principal = { role: "student", displayName: "Student" } as const;
const session = {
  token,
  issuedAt: "2026-10-05T10:00:00.000Z",
  expiresAt: "2026-10-05T10:30:00.000Z",
};

function answer(kind: string, requestId: string): Response {
  const common = { ...envelope, requestId };
  if (kind === "class-bootstrap")
    return json({
      ...common,
      kind: "class-selection-required",
      principal,
      classes: [{ classId: "class:two", displayName: "Two" }],
    });
  if (kind === "class-select")
    return json({
      ...common,
      kind: "class-bootstrapped",
      principal,
      classroom: { displayName: "Two" },
      modelAlias: "marea",
      activeRun: null,
    });
  if (kind === "external-auth-providers-query")
    return json({ ...common, kind: "external-auth-providers", providers: [] });
  if (kind === "external-auth-begin")
    return json({
      ...common,
      kind: "external-auth-started",
      flowId: "f".repeat(32),
      authorizationUrl: "https://accounts.example.test/auth",
      expiresAt: "2026-10-05T10:10:00.000Z",
    });
  return json({ ...common, kind: "external-authenticated", principal, session });
}

function recording() {
  const seen: Request[] = [];
  const fetch: StudentFetch = async (request) => {
    seen.push(request);
    const body = JSON.parse(await request.clone().text()) as {
      readonly kind: string;
      readonly requestId: string;
    };
    return answer(body.kind, body.requestId);
  };
  return { seen, fetch };
}

async function exercise(paths?: StudentHttpPaths) {
  const { seen, fetch } = recording();
  const server = createHttpStudentServer({
    baseUrl: "https://teacher.example",
    fetch,
    ...(paths === undefined ? {} : { paths }),
  });
  await expect(server.bootstrap(token, requests.bootstrap)).resolves.toMatchObject({
    authenticated: true,
    value: { kind: "class-selection-required" },
  });
  await expect(server.selectClass(token, requests.select)).resolves.toMatchObject({
    authenticated: true,
    value: { kind: "class-bootstrapped" },
  });
  await expect(server.externalProviders?.(requests.providers)).resolves.toMatchObject({
    providers: [],
  });
  await expect(server.beginExternal?.(requests.begin)).resolves.toMatchObject({
    flowId: "f".repeat(32),
  });
  await expect(server.completeExternal?.(requests.complete)).resolves.toMatchObject({
    session: { token },
  });
  return seen;
}

describe("student HTTP class selection and external sign-in", () => {
  it("calls the fixed endpoints with the session credential only where it is needed", async () => {
    const seen = await exercise();
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      STUDENT_HTTP_PATHS.bootstrap,
      "/v1/classes/select",
      "/v1/auth/external/providers",
      "/v1/auth/external/begin",
      "/v1/auth/external/complete",
    ]);
    expect(seen.map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${token}`,
      `Bearer ${token}`,
      null,
      null,
      null,
    ]);
  });

  it("uses configured endpoints and falls back to the fixed ones", async () => {
    const {
      appendEvents,
      bootstrap,
      capabilities,
      closeRun,
      enroll,
      login,
      modelGateway,
      openRun,
    } = STUDENT_HTTP_PATHS;
    const fallback = await exercise({
      appendEvents,
      bootstrap,
      capabilities,
      closeRun,
      enroll,
      login,
      modelGateway,
      openRun,
    });
    expect(fallback.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/classes/bootstrap",
      "/v1/classes/select",
      "/v1/auth/external/providers",
      "/v1/auth/external/begin",
      "/v1/auth/external/complete",
    ]);
    const custom = await exercise({
      ...STUDENT_HTTP_PATHS,
      selectClass: "/custom/select",
      externalProviders: "/custom/providers",
      beginExternal: "/custom/begin",
      completeExternal: "/custom/complete",
    });
    expect(custom.slice(1).map((request) => new URL(request.url).pathname)).toEqual([
      "/custom/select",
      "/custom/providers",
      "/custom/begin",
      "/custom/complete",
    ]);
  });

  it("reports a rejected selection credential and propagates other failures", async () => {
    const rejected = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () => json({ error: { code: "auth.invalid", retryable: false } }, 401),
    });
    await expect(rejected.selectClass(token, requests.select)).resolves.toEqual({
      authenticated: false,
    });
    const conflict = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () => json({ error: { code: "request.invalid", retryable: false } }, 409),
    });
    await expect(conflict.selectClass(token, requests.select)).rejects.toEqual(
      new StudentHttpError(409, "request.invalid", false),
    );
  });
});
