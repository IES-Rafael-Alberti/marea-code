import { afterEach, describe, expect, it, vi } from "vitest";

import { TeacherDomainError } from "../identity/errors.js";
import {
  BASE_URL,
  createApplication,
  createServices,
  fetchJson,
  loggedOut,
  RecordingProvider,
  SESSION_TOKEN,
  TEACHER_TOKEN,
} from "./product-http.fixture.js";

afterEach(() => {
  loggedOut.length = 0;
});

const ORIGIN = "https://dashboard.test";
const envelope = { protocolVersion: "0.1", requestId: "request:session" } as const;

function post(
  path: string,
  body: object,
  headers: Readonly<Record<string, string>> = { origin: ORIGIN },
): Request {
  return new Request(`${BASE_URL}/api/v1/dashboard/session${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "teacher.test", ...headers },
    method: "POST",
  });
}

const login = (password = "correct horse battery", name = "teacher") =>
  post("/login", {
    ...envelope,
    kind: "credential-login",
    credentials: { login: name, password },
  });

const teacherSession = {
  ...envelope,
  kind: "dashboard-session",
  principal: { displayName: "Teacher Grace", role: "teacher" },
};

function errorBody(code: string, retryable: boolean) {
  return { ...envelope, error: { code, retryable } };
}

describe("dashboard teacher session HTTP", () => {
  it("signs a teacher in with an HttpOnly cookie and never returns the token", async () => {
    for (const [secure, suffix] of [
      [true, "; Secure"],
      [false, ""],
    ] as const) {
      const signedIn = await fetchJson(createApplication(undefined, { secure }), login());
      expect(signedIn.response.status).toBe(200);
      expect(JSON.parse(signedIn.text)).toEqual(teacherSession);
      expect(signedIn.text).not.toContain(TEACHER_TOKEN);
      expect(signedIn.response.headers.get("set-cookie")).toBe(
        `marea_teacher_session=${TEACHER_TOKEN}; Path=/api/v1/dashboard; HttpOnly; SameSite=Strict${suffix}`,
      );
    }
    expect(loggedOut).toEqual([]);
  });

  it("revokes the session of a student who signs in and refuses the dashboard", async () => {
    const refused = await fetchJson(createApplication(), login(undefined, "student"));
    expect(refused.response.status).toBe(403);
    expect(JSON.parse(refused.text)).toEqual(errorBody("request.invalid", false));
    expect(refused.response.headers.get("set-cookie")).toBeNull();
    expect(loggedOut).toEqual([SESSION_TOKEN]);
  });

  it("maps invalid credentials, unexpected failures, bad input and foreign origins", async () => {
    const services = createServices(new RecordingProvider());
    const identity = services.identity;
    const failing = vi.fn();
    const app = createApplication({
      ...services,
      identity: {
        ...identity,
        login: (request) => {
          failing();
          if (request.credentials.password === "wrong password here")
            return Promise.reject(new TeacherDomainError("auth.invalid"));
          if (request.credentials.password === "broken password here")
            return Promise.reject(new TeacherDomainError("run.unavailable"));
          return identity.login(request);
        },
      },
    });
    const invalid = await fetchJson(app, login("wrong password here"));
    expect([invalid.response.status, JSON.parse(invalid.text)]).toEqual([
      401,
      errorBody("auth.invalid", false),
    ]);
    const broken = await fetchJson(app, login("broken password here"));
    expect([broken.response.status, JSON.parse(broken.text)]).toEqual([
      500,
      errorBody("server.error", true),
    ]);
    expect(failing).toHaveBeenCalledTimes(2);
    expect((await fetchJson(app, login("short"))).response.status).toBe(400);
    const oversized = post("/login", {
      ...envelope,
      kind: "credential-login",
      credentials: { login: "teacher", password: "x".repeat(4_096) },
    });
    expect((await fetchJson(app, oversized)).response.status).toBe(413);
    for (const headers of [{}, { origin: "https://elsewhere.test" }]) {
      const foreign = post(
        "/login",
        {
          ...envelope,
          kind: "credential-login",
          credentials: { login: "teacher", password: "correct horse battery" },
        },
        headers,
      );
      expect((await fetchJson(app, foreign)).response.status).toBe(403);
    }
    // Sign-in and sign-out accept no query string, so credentials never land in a URL.
    for (const path of ["/login?login=teacher", "/logout?x=1"]) {
      const withQuery = post(
        path,
        {
          ...envelope,
          kind: path.startsWith("/login") ? "credential-login" : "credential-logout",
          ...(path.startsWith("/login")
            ? { credentials: { login: "teacher", password: "correct horse battery" } }
            : {}),
        },
        { origin: ORIGIN, cookie: `marea_teacher_session=${TEACHER_TOKEN}` },
      );
      expect((await fetchJson(app, withQuery)).response.status, path).toBe(403);
    }
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("reports the signed-in teacher from the cookie and refuses anyone else", async () => {
    const app = createApplication();
    const query = (cookie?: string) =>
      fetchJson(
        app,
        post(
          "",
          { ...envelope, kind: "dashboard-session-query" },
          cookie === undefined ? {} : { cookie },
        ),
      );
    const current = await query(`marea_teacher_session=${TEACHER_TOKEN}`);
    expect([current.response.status, JSON.parse(current.text)]).toEqual([200, teacherSession]);
    for (const cookie of [undefined, "marea_teacher_session=unknown", "other=value"]) {
      const signedOut = await query(cookie);
      expect([signedOut.response.status, JSON.parse(signedOut.text)]).toEqual([
        401,
        errorBody("auth.invalid", false),
      ]);
    }
    const student = await query(`marea_teacher_session=${SESSION_TOKEN}`);
    expect([student.response.status, JSON.parse(student.text)]).toEqual([
      403,
      errorBody("request.invalid", false),
    ]);
    const malformed = await fetchJson(
      app,
      post(
        "",
        { ...envelope, kind: "dashboard-session" },
        { cookie: `marea_teacher_session=${TEACHER_TOKEN}` },
      ),
    );
    expect(malformed.response.status).toBe(400);
  });

  it("signs out by revoking the cookie session and clearing the cookie", async () => {
    for (const [secure, suffix] of [
      [true, "; Secure"],
      [false, ""],
    ] as const) {
      const app = createApplication(undefined, { secure });
      const logout = (headers: Record<string, string>) =>
        fetchJson(app, post("/logout", { ...envelope, kind: "credential-logout" }, headers));
      const done = await logout({
        origin: ORIGIN,
        cookie: `marea_teacher_session=${TEACHER_TOKEN}`,
      });
      expect(done.response.status).toBe(200);
      expect(JSON.parse(done.text)).toEqual({
        ...envelope,
        kind: "credential-logged-out",
        loggedOutAt: "2026-09-04T08:00:00.000Z",
        alreadyLoggedOut: false,
      });
      expect(done.response.headers.get("set-cookie")).toBe(
        `marea_teacher_session=; Path=/api/v1/dashboard; Max-Age=0; HttpOnly; SameSite=Strict${suffix}`,
      );
      const noCookie = await logout({ origin: ORIGIN });
      expect([noCookie.response.status, JSON.parse(noCookie.text)]).toEqual([
        401,
        errorBody("auth.invalid", false),
      ]);
      expect(
        (await logout({ cookie: `marea_teacher_session=${TEACHER_TOKEN}` })).response.status,
      ).toBe(403);
    }
    expect(loggedOut).toEqual([TEACHER_TOKEN, TEACHER_TOKEN]);
  });
});
