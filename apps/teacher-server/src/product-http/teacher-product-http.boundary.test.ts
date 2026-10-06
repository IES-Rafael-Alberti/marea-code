import { describe, expect, it } from "vitest";

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
  TEACHER_TOKEN,
} from "./product-http.fixture.js";

describe("teacher product HTTP boundary", () => {
  it("serves the complete authenticated base route surface without private routing data", async () => {
    const provider = new RecordingProvider();
    const app = createApplication(createServices(provider));

    const capabilities = await fetchJson(app, request("/v1/capabilities", capabilitiesRequest));
    const enrollment = await fetchJson(app, request("/v1/auth/enroll", enrollmentRequest));
    const studentLogin = await fetchJson(
      app,
      request("/v1/auth/login", {
        credentials: { login: "student", password: "student-password" },
        kind: "credential-login",
        protocolVersion: "0.1",
        requestId: "request:student-login",
      }),
    );
    const teacherLogin = await fetchJson(
      app,
      request("/v1/auth/login", {
        credentials: { login: "teacher", password: "teacher-password" },
        kind: "credential-login",
        protocolVersion: "0.1",
        requestId: "request:teacher-login",
      }),
    );
    const bootstrap = await fetchJson(
      app,
      request(
        "/v1/classes/bootstrap",
        { kind: "class-bootstrap", protocolVersion: "0.1", requestId: "request:bootstrap" },
        SESSION_TOKEN,
      ),
    );
    const opened = await fetchJson(app, request("/v1/runs/open", openRequest, SESSION_TOKEN));
    const renewed = await fetchJson(
      app,
      request(
        "/v1/runs/lease-renew",
        {
          kind: "run-lease-renewal",
          protocolVersion: "0.1",
          requestId: "request:renew",
          runId: "run:one",
        },
        SESSION_TOKEN,
      ),
    );
    const events = await fetchJson(app, request("/v1/runs/events", eventRequest, RUN_TOKEN));
    const model = await fetchJson(app, request("/v1/model/stream", modelRequest, RUN_TOKEN));
    const dashboard = await fetchJson(
      app,
      new Request(
        `${BASE_URL}/api/v1/dashboard/active-runs?kind=active-runs-query&protocolVersion=0.1&requestId=request%3Adashboard&limit=50`,
        { headers: { cookie: `marea_teacher_session=${TEACHER_TOKEN}`, host: "teacher.test" } },
      ),
    );
    const closed = await fetchJson(
      app,
      request(
        "/v1/runs/close",
        { protocolVersion: "0.1", reason: "student-exit", requestId: "request:close" },
        RUN_TOKEN,
      ),
    );
    const authenticatedClose = await fetchJson(
      app,
      request(
        "/v1/runs/close",
        {
          protocolVersion: "0.1",
          reason: "student-exit",
          requestId: "request:authenticated-close",
          runId: "run:one",
        },
        SESSION_TOKEN,
      ),
    );

    expect([
      capabilities.response.status,
      enrollment.response.status,
      studentLogin.response.status,
      teacherLogin.response.status,
      bootstrap.response.status,
      opened.response.status,
      renewed.response.status,
      events.response.status,
      model.response.status,
      dashboard.response.status,
      closed.response.status,
      authenticatedClose.response.status,
    ]).toEqual([200, 201, 200, 200, 200, 201, 200, 200, 200, 200, 200, 200]);
    expect(capabilities.text).toContain("marea.runs.lease-renewal");
    expect(capabilities.text).toContain("marea.runs.skills");
    expect(capabilities.text).toContain("marea.runs.exact-resume");
    expect(capabilities.text).toContain("marea.runs.authenticated-close");
    expect(studentLogin.response.headers.get("set-cookie")).toBeNull();
    expect(teacherLogin.response.headers.get("set-cookie")).toBe(
      `marea_teacher_session=${TEACHER_TOKEN}; Path=/api/v1/dashboard; HttpOnly; SameSite=Strict; Secure`,
    );
    expect(model.response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(model.text.trim().split("\n")).toHaveLength(3);
    const publicTraffic = JSON.stringify({
      bootstrap,
      capabilities,
      closed,
      dashboard,
      events,
      model,
      opened,
      renewed,
    });
    expect(publicTraffic).not.toContain("private-upstream-model");
    expect(publicTraffic).not.toContain("openrouter");
    expect(provider.requests[0]?.upstreamModel).toBe("private-upstream-model");
  });

  it("enforces host, optional-origin validation, JSON media type, size, schema, and route policy", async () => {
    const app = createApplication();
    const badHost = request("/v1/capabilities", capabilitiesRequest, undefined, {
      host: "attacker.test",
    });
    const badOrigin = request("/v1/capabilities", capabilitiesRequest, undefined, {
      origin: "https://attacker.test",
    });
    const allowedOrigin = request("/v1/capabilities", capabilitiesRequest, undefined, {
      origin: "https://dashboard.test",
    });
    const missingType = request("/v1/capabilities", capabilitiesRequest);
    missingType.headers.delete("content-type");
    const invalidJson = new Request(`${BASE_URL}/v1/capabilities`, {
      body: "{",
      headers: { "content-type": "application/json", host: "teacher.test" },
      method: "POST",
    });
    const oversized = request("/v1/capabilities", capabilitiesRequest, undefined, {
      "content-length": "70000",
    });
    const badSchema = request("/v1/capabilities", {
      ...capabilitiesRequest,
      clientVersion: "invalid",
    });

    for (const [input, status] of [
      [badHost, 403],
      [badOrigin, 403],
      [missingType, 415],
      [invalidJson, 400],
      [oversized, 413],
      [badSchema, 400],
    ] as const) {
      expect((await app.fetch(input)).status).toBe(status);
    }
    expect((await app.fetch(allowedOrigin)).status).toBe(200);
    for (const path of [
      "/v1/auth/enroll",
      "/v1/auth/login",
      "/v1/classes/bootstrap",
      "/v1/classes/select",
      "/v1/runs/open",
      "/v1/runs/lease-renew",
      "/v1/runs/events",
      "/v1/runs/close",
      "/v1/model/stream",
    ]) {
      expect((await app.fetch(request(path, {}))).status).toBe(400);
    }
    expect(
      (await app.fetch(new Request(`${BASE_URL}/missing`, { headers: { host: "teacher.test" } })))
        .status,
    ).toBe(404);
  });

  it("rejects invalid credentials, cookies, dashboard queries, and unavailable providers safely", async () => {
    const services = createServices(new RecordingProvider());
    const app = createApplication({
      ...services,
      providers: { resolve: () => undefined },
    });
    expect(
      (
        await app.fetch(
          request("/v1/classes/bootstrap", {
            kind: "class-bootstrap",
            protocolVersion: "0.1",
            requestId: "request:missing-auth",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          request(
            "/v1/classes/bootstrap",
            { kind: "class-bootstrap", protocolVersion: "0.1", requestId: "request:auth" },
            "invalid_token_000000000000000000000000",
          ),
        )
      ).status,
    ).toBe(401);
    expect((await app.fetch(request("/v1/model/stream", modelRequest, RUN_TOKEN))).status).toBe(
      503,
    );

    const query = `${BASE_URL}/api/v1/dashboard/active-runs?kind=active-runs-query&protocolVersion=0.1&requestId=request%3Adashboard&limit=50`;
    for (const cookie of [
      undefined,
      "marea_teacher_session=",
      `marea_teacher_session=${TEACHER_TOKEN}; marea_teacher_session=${TEACHER_TOKEN}`,
      "marea_teacher_session=bad token",
      `other=${TEACHER_TOKEN}`,
      `marea_teacher_session=${"a".repeat(8_193)}`,
    ]) {
      const headers = new Headers({ host: "teacher.test" });
      if (cookie !== undefined) headers.set("cookie", cookie);
      expect((await app.fetch(new Request(query, { headers }))).status).toBe(401);
    }
    for (const suffix of ["&extra=true", "&limit=50&limit=25", "&limit=zero"]) {
      expect(
        (
          await app.fetch(
            new Request(`${query}${suffix}`, {
              headers: { cookie: `marea_teacher_session=${TEACHER_TOKEN}`, host: "teacher.test" },
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await app.fetch(
          new Request(query.replace("limit=50", "limit=zero"), {
            headers: { cookie: `marea_teacher_session=${TEACHER_TOKEN}`, host: "teacher.test" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.fetch(
          new Request(`${query}&cursor=next_page`, {
            headers: { cookie: `marea_teacher_session=${TEACHER_TOKEN}`, host: "teacher.test" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(() => createApplication(services, { cookieName: "bad cookie" })).toThrow(
      "The dashboard cookie name is invalid.",
    );
  });

  it("maps all domain and unexpected failures to bounded protocol errors", async () => {
    const scenarios = [
      [new TeacherDomainError("auth.invalid"), 401, "auth.invalid"],
      [new TeacherDomainError("run.unavailable"), 409, "run.unavailable"],
      [new TeacherDomainError("request.conflict"), 409, "request.invalid"],
      [new TeacherDomainError("dashboard.forbidden"), 403, "request.invalid"],
      [new TeacherDomainError("invitation.unavailable"), 409, "request.invalid"],
      [new Error("private failure"), 500, "server.error"],
    ] as const;
    for (const [error, status, code] of scenarios) {
      const services = createServices(new RecordingProvider());
      const app = createApplication({
        ...services,
        identity: {
          ...services.identity,
          enroll: () => Promise.reject(error),
        },
      });
      const result = await fetchJson(app, request("/v1/auth/enroll", enrollmentRequest));
      expect(result.response.status).toBe(status);
      expect(result.text).toContain(`"code":"${code}"`);
      expect(result.text).not.toContain("private failure");
    }
  });

  it("supports a non-secure loopback dashboard cookie only when explicitly configured", async () => {
    const result = await fetchJson(
      createApplication(createServices(new RecordingProvider()), { secure: false }),
      request("/v1/auth/login", {
        credentials: { login: "teacher", password: "teacher-password" },
        kind: "credential-login",
        protocolVersion: "0.1",
        requestId: "request:teacher-login",
      }),
    );
    expect(result.response.headers.get("set-cookie")).not.toContain("; Secure");
  });

  it("uses the bounded global error response when request streaming itself fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(): void {
        throw new Error("private body failure");
      },
    });
    const init: RequestInit & { readonly duplex: "half" } = {
      body,
      duplex: "half",
      headers: { "content-type": "application/json", host: "teacher.test" },
      method: "POST",
    };

    const result = await fetchJson(
      createApplication(),
      new Request(`${BASE_URL}/v1/capabilities`, init),
    );

    expect(result.response.status).toBe(500);
    expect(result.text).not.toContain("private body failure");
  });
  it("binds an unscoped student session to one of its classes and bootstraps it", async () => {
    const app = createApplication(createServices(new RecordingProvider()));
    const select = (classId: string, token?: string) =>
      request(
        "/v1/classes/select",
        { kind: "class-select", protocolVersion: "0.1", requestId: "request:select", classId },
        token,
      );
    const selected = await app.fetch(select("class:physics", SESSION_TOKEN));
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({
      kind: "class-bootstrapped",
      requestId: "request:select",
      classroom: { displayName: "Physics" },
    });
    const conflict = await app.fetch(select("class:other", SESSION_TOKEN));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ requestId: "request:select" });
    expect((await app.fetch(select("class:physics"))).status).toBe(401);
  });
});

it.each(["0.1.0-preview.6", "9.0.0-preview.1"])(
  "accepts a client software version %s independently of the wire protocol",
  async (clientVersion) => {
    const app = createApplication(createServices(new RecordingProvider()));
    const response = await fetchJson(
      app,
      request("/v1/capabilities", {
        ...capabilitiesRequest,
        clientVersion,
      }),
    );
    expect(response.response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({
      serverVersion: "0.2.0",
      supportedProtocolVersions: ["0.1"],
    });
  },
);
