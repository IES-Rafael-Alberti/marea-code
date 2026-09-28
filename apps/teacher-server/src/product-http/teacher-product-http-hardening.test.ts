import { describe, expect, it, vi } from "vitest";

import { TeacherDomainError } from "../identity/errors.js";
import {
  BASE_URL,
  capabilitiesRequest,
  createApplication,
  createServices,
  enrollmentRequest,
  eventRequest,
  fetchJson,
  modelRequest,
  openRequest,
  RecordingProvider,
  request,
  RUN_TOKEN,
  SESSION_TOKEN,
  teacher,
  TEACHER_TOKEN,
} from "./product-http.fixture.js";

const DASHBOARD_PATH =
  "/api/v1/dashboard/active-runs?kind=active-runs-query&protocolVersion=0.1&requestId=request%3Adashboard&limit=50";

function dashboardRequest(cookie: string, suffix = ""): Request {
  return new Request(`${BASE_URL}${DASHBOARD_PATH}${suffix}`, {
    headers: { cookie, host: "teacher.test" },
  });
}

function expectedError(code: string, retryable: boolean, requestId?: string) {
  return {
    error: { code, retryable },
    protocolVersion: "0.1",
    ...(requestId === undefined ? {} : { requestId }),
  };
}

describe("teacher product HTTP hardening", () => {
  it("requires explicit model-budget admission and forwards the authorized lease without client routing data", async () => {
    const provider = new RecordingProvider();
    const services = createServices(provider);
    const providerFor = vi.fn(services.modelUsage.providerFor);
    const app = createApplication({ ...services, modelUsage: { providerFor } });
    const result = await fetchJson(app, request("/v1/model/stream", modelRequest, RUN_TOKEN));
    expect(result.response.status).toBe(200);
    expect(providerFor).toHaveBeenCalledExactlyOnceWith(
      services.runs.authorizeLease(RUN_TOKEN),
      modelRequest.requestId,
      provider,
    );
    providerFor.mockReturnValue(null);
    const refused = await fetchJson(app, request("/v1/model/stream", modelRequest, RUN_TOKEN));
    expect(refused.response.status).toBe(503);
    expect(JSON.parse(refused.text)).toEqual(
      expectedError("server.error", false, modelRequest.requestId),
    );
  });

  it("returns exact bounded policy, not-found, and global error envelopes", async () => {
    const app = createApplication();
    const policy = await fetchJson(
      app,
      request("/v1/capabilities?forbidden=true", capabilitiesRequest),
    );
    const missing = await fetchJson(
      app,
      new Request(`${BASE_URL}/missing`, { headers: { host: "teacher.test" } }),
    );
    const brokenBody = new ReadableStream<Uint8Array>({
      pull(): void {
        throw new Error("private body failure");
      },
    });
    const failure = await fetchJson(
      app,
      new Request(`${BASE_URL}/v1/capabilities`, {
        body: brokenBody,
        duplex: "half",
        headers: { "content-type": "application/json", host: "teacher.test" },
        method: "POST",
      } as RequestInit & { readonly duplex: "half" }),
    );

    expect([policy.response.status, missing.response.status, failure.response.status]).toEqual([
      403, 404, 500,
    ]);
    expect(JSON.parse(policy.text)).toEqual({
      error: { code: "request.invalid", retryable: false },
      protocolVersion: "0.1",
    });
    expect(JSON.parse(missing.text)).toEqual({
      error: { code: "request.invalid", retryable: false },
      protocolVersion: "0.1",
    });
    expect(JSON.parse(failure.text)).toEqual({
      error: { code: "server.error", retryable: true },
      protocolVersion: "0.1",
    });
  });

  it("returns exact errors for every JSON and dashboard-query rejection boundary", async () => {
    const app = createApplication();
    const missingType = request("/v1/capabilities", capabilitiesRequest);
    missingType.headers.delete("content-type");
    const malformed = new Request(`${BASE_URL}/v1/capabilities`, {
      body: "{",
      headers: { "content-type": "application/json", host: "teacher.test" },
      method: "POST",
    });
    const cases = [
      [missingType, 415],
      [
        request("/v1/capabilities", capabilitiesRequest, undefined, {
          "content-length": "70000",
        }),
        413,
      ],
      [request("/v1/capabilities", { ...capabilitiesRequest, clientVersion: "invalid" }), 400],
      [malformed, 400],
    ] as const;

    for (const [input, status] of cases) {
      const result = await fetchJson(app, input);
      expect(result.response.status).toBe(status);
      expect(JSON.parse(result.text)).toEqual(expectedError("request.invalid", false));
    }

    for (const suffix of ["&extra=true", "&cursor=one&cursor=two", "&limit=invalid"]) {
      const result = await fetchJson(
        app,
        dashboardRequest(`marea_teacher_session=${TEACHER_TOKEN}`, suffix),
      );
      expect(result.response.status).toBe(400);
      expect(JSON.parse(result.text)).toEqual(expectedError("request.invalid", false));
    }
    const invalidSchema = await fetchJson(
      app,
      new Request(`${BASE_URL}${DASHBOARD_PATH.replace("limit=50", "limit=invalid")}`, {
        headers: { cookie: `marea_teacher_session=${TEACHER_TOKEN}`, host: "teacher.test" },
      }),
    );
    expect(invalidSchema.response.status).toBe(400);
    expect(JSON.parse(invalidSchema.text)).toEqual(expectedError("request.invalid", false));
  });

  it("maps every domain category to an exact request-scoped envelope", async () => {
    const scenarios = [
      [new TeacherDomainError("auth.invalid"), 401, "auth.invalid", false],
      [new TeacherDomainError("run.unavailable"), 409, "run.unavailable", false],
      [new TeacherDomainError("request.conflict"), 409, "request.invalid", false],
      [new TeacherDomainError("dashboard.forbidden"), 403, "request.invalid", false],
      [new TeacherDomainError("invitation.unavailable"), 409, "request.invalid", false],
      [new Error("private"), 500, "server.error", true],
    ] as const;

    for (const [error, status, code, retryable] of scenarios) {
      const services = createServices(new RecordingProvider());
      const result = await fetchJson(
        createApplication({
          ...services,
          identity: { ...services.identity, enroll: () => Promise.reject(error) },
        }),
        request("/v1/auth/enroll", enrollmentRequest),
      );
      expect(result.response.status).toBe(status);
      expect(JSON.parse(result.text)).toEqual({
        error: { code, retryable },
        protocolVersion: "0.1",
        requestId: "request:enroll",
      });
    }
  });

  it("accepts a trimmed cookie at the exact header limit and forwards exact dashboard authority", async () => {
    const services = createServices(new RecordingProvider());
    const query = vi.spyOn(services.dashboard, "query");
    const prefix = `unrelated=value; marea_teacher_session=${TEACHER_TOKEN}`;
    const cookie = `${prefix};${"x".repeat(8_192 - prefix.length - 1)}`;
    const result = await fetchJson(
      createApplication(services),
      dashboardRequest(cookie, "&cursor=next_page"),
    );

    expect(cookie).toHaveLength(8_192);
    expect(result.response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      { identity: teacher },
      expect.objectContaining({ cursor: "next_page", limit: 50, requestId: "request:dashboard" }),
    );
  });

  it("rejects every ambiguous cookie and query representation", async () => {
    const services = createServices(new RecordingProvider());
    const authenticate = vi.spyOn(services.identity, "authenticate");
    const app = createApplication(services);
    const invalidCookies = [
      "marea_teacher_session=",
      `marea_teacher_session=${TEACHER_TOKEN}; marea_teacher_session=${TEACHER_TOKEN}`,
      `marea_teacher_session=${TEACHER_TOKEN} extra`,
      `marea_teacher_session=${TEACHER_TOKEN};x=${"a".repeat(8_192)}`,
      `marea_teacher_sessionx=${TEACHER_TOKEN}`,
    ];
    for (const cookie of invalidCookies) {
      const response = await app.fetch(dashboardRequest(cookie));
      expect(response.status).toBe(401);
    }
    expect(authenticate).not.toHaveBeenCalled();
    for (const suffix of ["&extra=true", "&limit=25", "&cursor=a&cursor=b"]) {
      const response = await app.fetch(
        dashboardRequest(`marea_teacher_session=${TEACHER_TOKEN}`, suffix),
      );
      expect(response.status).toBe(400);
    }
  });

  it("enforces cookie-name boundaries and explicit secure-cookie behavior", async () => {
    const validName = "a".repeat(64);
    const valid = await createApplication(undefined, { cookieName: validName }).fetch(
      request("/v1/auth/login", {
        credentials: { login: "teacher", password: "teacher-password" },
        kind: "credential-login",
        protocolVersion: "0.1",
        requestId: "request:login",
      }),
    );
    expect(valid.headers.get("set-cookie")).toBe(
      `${validName}=${TEACHER_TOKEN}; Path=/api/v1/dashboard; HttpOnly; SameSite=Strict; Secure`,
    );
    for (const name of ["", "a".repeat(65), "bad.name", "bad name"]) {
      expect(() => createApplication(undefined, { cookieName: name })).toThrow(
        "The dashboard cookie name is invalid.",
      );
    }
    const insecure = await createApplication(undefined, { secure: false }).fetch(
      request("/v1/auth/login", {
        credentials: { login: "teacher", password: "teacher-password" },
        kind: "credential-login",
        protocolVersion: "0.1",
        requestId: "request:login",
      }),
    );
    expect(insecure.headers.get("set-cookie")).toBe(
      `marea_teacher_session=${TEACHER_TOKEN}; Path=/api/v1/dashboard; HttpOnly; SameSite=Strict`,
    );
  });

  it("rejects a missing bearer credential before calling authentication", async () => {
    const services = createServices(new RecordingProvider());
    const authenticate = vi.spyOn(services.identity, "authenticate");
    const result = await fetchJson(
      createApplication(services),
      request("/v1/classes/bootstrap", {
        kind: "class-bootstrap",
        protocolVersion: "0.1",
        requestId: "request:bootstrap",
      }),
    );

    expect(result.response.status).toBe(401);
    expect(JSON.parse(result.text)).toEqual(
      expectedError("auth.invalid", false, "request:bootstrap"),
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("forwards exact event, renewal, and close capabilities and returns exact responses", async () => {
    const services = createServices(new RecordingProvider());
    const append = vi.spyOn(services.runs, "append");
    const close = vi.spyOn(services.runs, "close");
    const closeAuthenticated = vi.spyOn(services.runs, "closeAuthenticated");
    const renew = vi.spyOn(services.runs, "renew");
    const app = createApplication(services);
    const closeRequest = {
      protocolVersion: "0.1",
      reason: "student-exit",
      requestId: "request:close",
    } as const;
    const renewalRequest = {
      kind: "run-lease-renewal",
      protocolVersion: "0.1",
      requestId: "request:renew",
      runId: "run:one",
    } as const;
    const authenticatedCloseRequest = {
      ...closeRequest,
      requestId: "request:close-authenticated",
      runId: "run:one",
    } as const;

    const events = await fetchJson(app, request("/v1/runs/events", eventRequest, RUN_TOKEN));
    const renewed = await fetchJson(
      app,
      request("/v1/runs/lease-renew", renewalRequest, SESSION_TOKEN),
    );
    const closed = await fetchJson(app, request("/v1/runs/close", closeRequest, RUN_TOKEN));
    const closedAuthenticated = await fetchJson(
      app,
      request("/v1/runs/close", authenticatedCloseRequest, SESSION_TOKEN),
    );

    expect(events.response.status).toBe(200);
    expect(JSON.parse(events.text)).toEqual({
      highestDurableSequence: 2,
      kind: "run-events-acknowledged",
      protocolVersion: "0.1",
      requestId: "request:events",
    });
    expect(append).toHaveBeenCalledExactlyOnceWith(RUN_TOKEN, eventRequest);
    expect(renewed.response.status).toBe(200);
    expect(JSON.parse(renewed.text)).toMatchObject({
      kind: "run-lease-renewed",
      requestId: "request:renew",
      lease: { runId: "run:one" },
    });
    expect(renew).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: "user:student" }),
      renewalRequest,
    );
    expect(closed.response.status).toBe(200);
    expect(JSON.parse(closed.text)).toEqual({
      alreadyClosed: false,
      protocolVersion: "0.1",
      requestId: "request:close",
      runId: "run:one",
      state: "closed",
    });
    expect(close).toHaveBeenCalledExactlyOnceWith(RUN_TOKEN, "request:close", "student-exit");
    expect(closedAuthenticated.response.status).toBe(200);
    expect(closeAuthenticated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: "user:student" }),
      authenticatedCloseRequest,
    );
  });

  it("rejects authenticated run recovery after the student identity is revoked", async () => {
    const services = createServices(new RecordingProvider());
    const open = vi.spyOn(services.runs, "open");
    const renew = vi.spyOn(services.runs, "renew");
    const closeAuthenticated = vi.spyOn(services.runs, "closeAuthenticated");
    const app = createApplication({
      ...services,
      identity: {
        ...services.identity,
        authenticate() {
          throw new TeacherDomainError("auth.invalid");
        },
      },
    });
    const responses = await Promise.all([
      app.fetch(
        request(
          "/v1/runs/open",
          {
            ...openRequest,
            intent: { kind: "resume" },
            requestId: "request:revoked-resume",
            runId: "run:one",
          },
          SESSION_TOKEN,
        ),
      ),
      app.fetch(
        request(
          "/v1/runs/lease-renew",
          {
            kind: "run-lease-renewal",
            protocolVersion: "0.1",
            requestId: "request:revoked-renew",
            runId: "run:one",
          },
          SESSION_TOKEN,
        ),
      ),
      app.fetch(
        request(
          "/v1/runs/close",
          {
            protocolVersion: "0.1",
            reason: "student-exit",
            requestId: "request:revoked-close",
            runId: "run:one",
          },
          SESSION_TOKEN,
        ),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(open).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(closeAuthenticated).not.toHaveBeenCalled();
  });

  it("returns an exact retryable envelope when the private provider is unavailable", async () => {
    const services = createServices(new RecordingProvider());
    const result = await fetchJson(
      createApplication({ ...services, providers: { resolve: () => undefined } }),
      request("/v1/model/stream", modelRequest, RUN_TOKEN),
    );

    expect(result.response.status).toBe(503);
    expect(JSON.parse(result.text)).toEqual(expectedError("server.error", true, "request:model"));
  });

  it("keeps lease authorization and private model routing server-side", async () => {
    const provider = new RecordingProvider();
    const services = createServices(provider);
    const authorizeLease = vi.spyOn(services.runs, "authorizeLease");
    const resolve = vi.spyOn(services.providers, "resolve");
    const response = await createApplication(services).fetch(
      request("/v1/model/stream", modelRequest, RUN_TOKEN),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(authorizeLease).toHaveBeenCalledExactlyOnceWith(RUN_TOKEN);
    expect(resolve).toHaveBeenCalledExactlyOnceWith("openrouter");
    expect(provider.requests[0]?.upstreamModel).toBe("private-upstream-model");
  });
});
