/* eslint-disable @typescript-eslint/require-await */
import {
  AppendRunEventsRequestSchema,
  CapabilitiesRequestSchema,
  ClassBootstrapRequestSchema,
  CloseRunRequestSchema,
  CredentialLoginRequestSchema,
  EnrollStudentRequestSchema,
  EventIdSchema,
  IdempotencyKeySchema,
  OpenRunRequestSchema,
  RequestIdSchema,
  RenewRunLeaseRequestSchema,
  RunTokenSchema,
  SessionTokenSchema,
  SnapshotIdSchema,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  STUDENT_HTTP_PATHS,
  StudentHttpError,
  createHttpStudentServer,
  type StudentFetch,
} from "./http-client.boundary.js";
import { invalidUtf8Response } from "./http-test.fixture.js";

const sessionToken = SessionTokenSchema.parse("s".repeat(32));
const runToken = RunTokenSchema.parse("r".repeat(32));
const digest = `sha256:${"a".repeat(64)}`;
const timestamp = "2026-09-04T10:00:00.000Z";

function json(value: object, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function requestId(value: string) {
  return RequestIdSchema.parse(value);
}

function responseFor(path: string, id: string): Response {
  const common = { protocolVersion: "0.1", requestId: id };
  if (path === STUDENT_HTTP_PATHS.capabilities || path === "/custom/capabilities") {
    return json({
      ...common,
      serverVersion: "1.0.0",
      supportedProtocolVersions: ["0.1"],
      capabilities: ["marea.auth.student"],
    });
  }
  if (path === STUDENT_HTTP_PATHS.enroll) {
    return json({
      ...common,
      kind: "student-invitation-enrolled",
      principal: { role: "student", displayName: "Student" },
      session: { token: sessionToken, issuedAt: timestamp, expiresAt: "2026-09-05T10:00:00.000Z" },
    });
  }
  if (path === STUDENT_HTTP_PATHS.login) {
    return json({
      ...common,
      kind: "credential-authenticated",
      principal: { role: "student", displayName: "Student" },
      session: { token: sessionToken, issuedAt: timestamp, expiresAt: "2026-09-05T10:00:00.000Z" },
    });
  }
  if (path === STUDENT_HTTP_PATHS.bootstrap) {
    return json({
      ...common,
      kind: "class-bootstrapped",
      principal: { role: "student", displayName: "Student" },
      classroom: { displayName: "Class" },
      modelAlias: "marea",
      activeRun: null,
    });
  }
  if (path === STUDENT_HTTP_PATHS.openRun) {
    return json({
      ...common,
      highestDurableSequence: 1,
      lease: {
        runId: "run:1",
        token: runToken,
        issuedAt: timestamp,
        expiresAt: "2026-09-05T10:00:00.000Z",
      },
      snapshot: {
        id: SnapshotIdSchema.parse("snapshot:1"),
        agentMode: "tutoring",
        modelAlias: "marea",
        prompt: { version: "prompt:1", digest, content: "Help." },
        didacticSkills: [],
        teacherToolPolicy: { version: "tools:1", restrictions: [] },
      },
    });
  }
  if (path === STUDENT_HTTP_PATHS.appendEvents) {
    return json({
      ...common,
      kind: "run-events-acknowledged",
      highestDurableSequence: 2,
    });
  }
  if (path === STUDENT_HTTP_PATHS.renewLease) {
    return json({
      ...common,
      kind: "run-lease-renewed",
      lease: {
        expiresAt: "2026-09-04T10:10:00.000Z",
        issuedAt: timestamp,
        runId: "run:1",
        token: runToken,
      },
    });
  }
  return json({ ...common, runId: "run:1", state: "closed", alreadyClosed: false });
}

const requests = {
  append: AppendRunEventsRequestSchema.parse({
    kind: "run-events-append",
    protocolVersion: "0.1",
    requestId: "request:append",
    events: [
      {
        eventType: "student-message",
        eventId: EventIdSchema.parse("event:1"),
        sequence: 2,
        occurredAt: timestamp,
        content: "Hello",
      },
    ],
  }),
  bootstrap: ClassBootstrapRequestSchema.parse({
    kind: "class-bootstrap",
    protocolVersion: "0.1",
    requestId: "request:bootstrap",
  }),
  capabilities: CapabilitiesRequestSchema.parse({
    requestId: "request:capabilities",
    clientVersion: "1.0.0",
    supportedProtocolVersions: ["0.1"],
  }),
  close: CloseRunRequestSchema.parse({
    protocolVersion: "0.1",
    requestId: "request:close",
    reason: "student-exit",
  }),
  enroll: EnrollStudentRequestSchema.parse({
    kind: "student-invitation-enrollment",
    protocolVersion: "0.1",
    requestId: "request:enroll",
    invitationCode: "invitation-code",
    displayName: "Student",
    credentials: { login: "student", password: "password-long" },
  }),
  login: CredentialLoginRequestSchema.parse({
    kind: "credential-login",
    protocolVersion: "0.1",
    requestId: "request:login",
    credentials: { login: "student", password: "password-long" },
  }),
  open: OpenRunRequestSchema.parse({
    protocolVersion: "0.1",
    clientVersion: "1.0.0",
    requestId: "request:open",
    idempotencyKey: IdempotencyKeySchema.parse("open:1"),
    clientSessionId: "client:1",
    project: { displayName: "Project" },
    intent: { kind: "new" },
  }),
  renew: RenewRunLeaseRequestSchema.parse({
    kind: "run-lease-renewal",
    protocolVersion: "0.1",
    requestId: "request:renew",
    runId: "run:1",
  }),
};

describe("HTTP student server boundary", () => {
  it("exposes stable transport error diagnostics", () => {
    const error = new StudentHttpError(409, "response.invalid", false);
    expect({
      code: error.code,
      message: error.message,
      name: error.name,
      retryable: error.retryable,
      status: error.status,
    }).toEqual({
      code: "response.invalid",
      message: "The Marea teacher server rejected the request.",
      name: "StudentHttpError",
      retryable: false,
      status: 409,
    });
  });

  it("calls every fixed endpoint with correlated strict JSON and bearer authority", async () => {
    const seen: Request[] = [];
    const fetchRequest: StudentFetch = async (request) => {
      seen.push(request);
      const body = JSON.parse(await request.text()) as { readonly requestId: string };
      return responseFor(new URL(request.url).pathname, body.requestId);
    };
    const server = createHttpStudentServer({
      baseUrl: "https://teacher.example/base",
      fetch: fetchRequest,
    });

    await server.capabilities(requests.capabilities);
    await server.enroll(requests.enroll);
    await server.login(requests.login);
    await expect(server.bootstrap(sessionToken, requests.bootstrap)).resolves.toMatchObject({
      authenticated: true,
      value: { classroom: { displayName: "Class" } },
    });
    await server.openRun(sessionToken, requests.open);
    await server.renewLease(sessionToken, requests.renew);
    await server.closeRunAuthenticated(
      sessionToken,
      CloseRunRequestSchema.parse({ ...requests.close, runId: "run:1" }),
    );
    await server.appendRunEvents(runToken, requests.append);
    await server.closeRun(runToken, requests.close);

    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      STUDENT_HTTP_PATHS.capabilities,
      STUDENT_HTTP_PATHS.enroll,
      STUDENT_HTTP_PATHS.login,
      STUDENT_HTTP_PATHS.bootstrap,
      STUDENT_HTTP_PATHS.openRun,
      STUDENT_HTTP_PATHS.renewLease,
      STUDENT_HTTP_PATHS.closeRun,
      STUDENT_HTTP_PATHS.appendEvents,
      STUDENT_HTTP_PATHS.closeRun,
    ]);
    expect(seen.every((request) => request.method === "POST" && request.redirect === "error")).toBe(
      true,
    );
    expect(
      seen.every(
        (request) =>
          request.headers.get("accept") === "application/json" &&
          request.headers.get("connection") === "close" &&
          request.headers.get("content-type") === "application/json",
      ),
    ).toBe(true);
    expect(seen.slice(0, 3).every((request) => !request.headers.has("authorization"))).toBe(true);
    expect(
      seen
        .slice(3, 7)
        .every((request) => request.headers.get("authorization") === `Bearer ${sessionToken}`),
    ).toBe(true);
    expect(
      seen
        .slice(7)
        .every((request) => request.headers.get("authorization") === `Bearer ${runToken}`),
    ).toBe(true);
  });

  it("turns only an explicit invalid credential response into unauthenticated bootstrap", async () => {
    const invalid = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () => json({ error: { code: "auth.invalid", retryable: false } }, 401),
    });
    await expect(invalid.bootstrap(sessionToken, requests.bootstrap)).resolves.toEqual({
      authenticated: false,
    });

    const unavailable = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () => json({ error: { code: "server.error", retryable: true } }, 503),
    });
    await expect(unavailable.bootstrap(sessionToken, requests.bootstrap)).rejects.toEqual(
      new StudentHttpError(503, "server.error", true),
    );
  });

  it.each([
    "ftp://teacher.example",
    "https://user:pass@teacher.example",
    "https://user@teacher.example",
    "https://:pass@teacher.example",
    "https://teacher.example?query=yes",
    "https://teacher.example#fragment",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() => createHttpStudentServer({ baseUrl })).toThrow(
      "The teacher server URL must be HTTP or HTTPS without credentials, query, or fragment.",
    );
  });

  it("accepts explicit HTTP and validates timeout bounds", () => {
    expect(() =>
      createHttpStudentServer({ baseUrl: "http://teacher.example:18787", timeoutMs: 100 }),
    ).not.toThrow();
    expect(() =>
      createHttpStudentServer({ baseUrl: "http://127.0.0.1", timeoutMs: 300_000 }),
    ).not.toThrow();
    expect(() => createHttpStudentServer({ baseUrl: "http://[::1]" })).not.toThrow();
    for (const timeoutMs of [99, 300_001, 1.5, Number.NaN]) {
      expect(() =>
        createHttpStudentServer({ baseUrl: "https://teacher.example", timeoutMs }),
      ).toThrow("The teacher server timeout is invalid.");
    }
  });

  it("rejects malformed, mismatched, empty, oversized, and invalid UTF-8 responses", async () => {
    const responses: readonly (readonly [Response, string])[] = [
      [responseFor(STUDENT_HTTP_PATHS.capabilities, "request:wrong"), "response.invalid"],
      [new Response("{}", { headers: { "content-type": "text/plain" } }), "response.invalid"],
      [new Response(null, { headers: { "content-type": "application/json" } }), "response.invalid"],
      [
        new Response("{}", {
          headers: { "content-length": "1048577", "content-type": "application/json" },
        }),
        "response.too-large",
      ],
      [
        new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
        "response.invalid",
      ],
      [
        new Response("x".repeat(1_048_576), {
          headers: { "content-type": "application/json" },
        }),
        "response.invalid",
      ],
      [json({ requestId: requests.capabilities.requestId }), "response.invalid"],
      [new Response(new TextEncoder().encode("{}")), "response.invalid"],
    ];
    for (const [response, code] of responses) {
      const server = createHttpStudentServer({
        baseUrl: "https://teacher.example",
        fetch: async () => response,
      });
      await expect(server.capabilities(requests.capabilities)).rejects.toEqual(
        new StudentHttpError(200, code, false),
      );
    }
  });

  it("bounds streamed JSON bodies even without a content length and normalizes malformed errors", async () => {
    const oversized = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () =>
        new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
    });
    await expect(oversized.capabilities(requests.capabilities)).rejects.toEqual(
      new StudentHttpError(200, "response.too-large", false),
    );
    const malformed = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () =>
        new Response("not-json", { headers: { "content-type": "application/json" }, status: 500 }),
    });
    await expect(malformed.capabilities(requests.capabilities)).rejects.toEqual(
      new StudentHttpError(500, "server.error", true),
    );
    const invalidUtf8 = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () => new Response(new Uint8Array([255]), { status: 500 }),
    });
    await expect(invalidUtf8.capabilities(requests.capabilities)).rejects.toEqual(
      new StudentHttpError(500, "server.error", true),
    );
    const oversizedError = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () =>
        new Response("error", {
          headers: { "content-length": "1048577" },
          status: 500,
        }),
    });
    await expect(oversizedError.capabilities(requests.capabilities)).rejects.toEqual(
      new StudentHttpError(500, "response.too-large", false),
    );
    const malformedClient = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () => new Response("invalid", { status: 400 }),
    });
    await expect(malformedClient.capabilities(requests.capabilities)).rejects.toEqual(
      new StudentHttpError(400, "server.error", false),
    );
  });

  it("rejects a request over the transport bound before fetching", async () => {
    const fetchRequest = vi.fn<StudentFetch>();
    const server = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: fetchRequest,
    });
    await expect(
      server.capabilities({
        ...requests.capabilities,
        clientVersion: "x".repeat(1_048_577),
      }),
    ).rejects.toThrow("The teacher server request exceeds its size limit.");
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("accepts exact transport bounds and assembles a multi-chunk JSON response", async () => {
    const emptyVersionRequest = { ...requests.capabilities, clientVersion: "" };
    const overhead = new TextEncoder().encode(JSON.stringify(emptyVersionRequest)).byteLength;
    const exactRequest = {
      ...emptyVersionRequest,
      clientVersion: "x".repeat(1_048_576 - overhead),
    };
    const response = responseFor(STUDENT_HTTP_PATHS.capabilities, requests.capabilities.requestId);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    const fetchRequest = vi.fn<StudentFetch>(
      async () =>
        new Response(stream, {
          headers: {
            "content-length": "1048576",
            "content-type": " application/json ; charset=utf-8 ",
          },
        }),
    );
    const exactPath = `/${"x".repeat(255)}`;
    const server = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: fetchRequest,
      paths: { ...STUDENT_HTTP_PATHS, capabilities: exactPath },
    });
    await expect(server.capabilities(exactRequest)).resolves.toMatchObject({
      requestId: requests.capabilities.requestId,
    });
    expect(new URL(fetchRequest.mock.calls[0]?.[0].url ?? "").pathname).toBe(exactPath);
  });

  it("rejects malformed UTF-8 even when replacement text would satisfy the response schema", async () => {
    const text = await responseFor(STUDENT_HTTP_PATHS.openRun, requests.open.requestId).text();
    const server = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: async () => invalidUtf8Response(text, "Help.", "application/json"),
    });
    await expect(server.openRun(sessionToken, requests.open)).rejects.toEqual(
      new StudentHttpError(200, "response.invalid", false),
    );
  });

  it("supports explicit endpoint maps and defaults their optional renewal path", async () => {
    const fetchRequest = vi.fn<StudentFetch>(async (request) => {
      const body = JSON.parse(await request.text()) as { readonly requestId: string };
      return responseFor(new URL(request.url).pathname, body.requestId);
    });
    const paths = { ...STUDENT_HTTP_PATHS, capabilities: "/custom/capabilities" };
    const server = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: fetchRequest,
      paths,
    });
    await server.capabilities({ ...requests.capabilities, requestId: requestId("request:custom") });
    expect(fetchRequest.mock.calls[0]?.[0].url).toBe("https://teacher.example/custom/capabilities");
    const { renewLease, ...legacyPaths } = paths;
    expect(renewLease).toBe(STUDENT_HTTP_PATHS.renewLease);
    const legacyServer = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: fetchRequest,
      paths: legacyPaths,
    });
    await legacyServer.renewLease(sessionToken, requests.renew);
    expect(new URL(fetchRequest.mock.calls[1]?.[0].url ?? "").pathname).toBe(
      STUDENT_HTTP_PATHS.renewLease,
    );
  });

  it.each([
    "relative",
    "//another.example/path",
    "//teacher.example/path",
    `/${"x".repeat(256)}`,
    "/path?query=yes",
    "/path#fragment",
    "/\\another.example/path",
  ])("rejects an unsafe endpoint path %s", async (capabilities) => {
    const fetchRequest = vi.fn<StudentFetch>();
    const server = createHttpStudentServer({
      baseUrl: "https://teacher.example",
      fetch: fetchRequest,
      paths: { ...STUDENT_HTTP_PATHS, capabilities },
    });
    await expect(server.capabilities(requests.capabilities)).rejects.toThrow(
      "A teacher server endpoint path is invalid.",
    );
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});
