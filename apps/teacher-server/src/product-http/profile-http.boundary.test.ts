import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdentityService } from "../identity/identity-service.js";
import { SqliteIdentityRepository } from "../platform/persistence/sqlite-identity-repository.js";
import { profileHarness, request, write, schemas } from "../dashboard-profiles/profile.fixture.js";
import { createTeacherProductHttp } from "./teacher-product-http.boundary.js";
import { createServices, RecordingProvider } from "./product-http.fixture.js";
import type { DashboardProfileEndpoint } from "../dashboard-profiles/contracts.js";
let h: ReturnType<typeof profileHarness>;
beforeEach(() => {
  h = profileHarness();
});
afterEach(() => {
  h.database.close();
});
function app(service: DashboardProfileEndpoint | null = h.service) {
  h.database.execute(
    "INSERT OR REPLACE INTO marea_auth_sessions VALUES ('session','teacher-1','synthetic-token','2026-09-22T00:00:00Z','2026-09-23T00:00:00Z',NULL)",
  );
  const identity = new IdentityService({
    repository: new SqliteIdentityRepository(h.database),
    clock: { now: () => "2026-09-22T12:00:00Z" },
    digest: { digest: (token) => token },
    ids: { createId: () => "unused" },
    secrets: { issue: () => "unused" },
    passwords: { hash: () => Promise.resolve("unused"), verify: () => Promise.resolve(false) },
    dummyPasswordHash: "unused",
  });
  return createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: ["https://teacher.test"],
    serverVersion: "0.0.0",
    services: {
      ...createServices(new RecordingProvider()),
      identity,
      ...(service === null ? {} : { profiles: service }),
    },
  });
}
function http(operation: string, body: BodyInit | null, changes: Record<string, string> = {}) {
  return new Request(`https://teacher.test/api/v1/dashboard/profiles/${operation}`, {
    method: "POST",
    body,
    headers: {
      host: "teacher.test",
      "content-type": "application/json",
      origin: "https://teacher.test",
      cookie: "marea_teacher_session=synthetic-token",
      ...changes,
    },
    duplex: "half",
  } as RequestInit);
}
it("serves authenticated SQLite save/read/catalog/reset, echoing request IDs and no-store", async () => {
  const server = app();
  const saved = await server.fetch(http("save", JSON.stringify(write())));
  expect(saved.status).toBe(200);
  expect(saved.headers.get("cache-control")).toBe("no-store");
  expect(schemas.state.parse(await saved.json()).personal.revision).toBe("profile-1");
  const read = await server.fetch(http("read", JSON.stringify(request("read"))));
  expect(schemas.state.parse(await read.json())).toMatchObject({
    requestId: "profile-request",
    personal: { revision: "profile-1" },
  });
  expect((await server.fetch(http("catalog", JSON.stringify(request("catalog"))))).status).toBe(
    200,
  );
  expect((await server.fetch(http("save", JSON.stringify(write())))).status).toBe(409);
});
it("rejects missing/revoked cookies, foreign origins and unknown envelopes", async () => {
  const server = app();
  for (const [headers, status] of [
    [{ cookie: "" }, 401],
    [{ origin: "https://evil.test" }, 403],
    [{ "content-type": "text/plain" }, 400],
  ] as const) {
    const response = await server.fetch(http("read", JSON.stringify(request("read")), headers));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const body of [
    "{",
    JSON.stringify(request("read", { extra: true })),
    JSON.stringify(request("read", { protocolVersion: "2.0" })),
  ])
    expect((await server.fetch(http("read", body))).status).toBe(400);
  h.database.execute("UPDATE marea_auth_sessions SET revoked_at = '2026-09-22T12:00:00Z'");
  expect((await server.fetch(http("read", JSON.stringify(request("read"))))).status).toBe(401);
});
it("counts streamed bytes, ignores lying length and rejects invalid UTF-8", async () => {
  const server = app();
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(32_769));
    },
    cancel() {
      canceled = true;
    },
  });
  expect((await server.fetch(http("read", stream, { "content-length": "1" }))).status).toBe(413);
  expect(canceled).toBe(true);
  expect((await server.fetch(http("read", new Uint8Array([0xff])))).status).toBe(400);
  expect((await server.fetch(http("read", null))).status).toBe(400);
});
it("sanitizes unexpected failures and caps UTF-8 responses", async () => {
  for (const service of [
    { execute: () => ({ value: "é".repeat(131_073) }) },
    {
      execute: () => {
        throw new Error("secret path");
      },
    },
  ]) {
    const response = await app(service).fetch(http("read", JSON.stringify(request("read"))));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  }
});
it("keeps profiles unavailable until explicit release composition", async () => {
  const response = await app(null).fetch(http("read", JSON.stringify(request("read"))));
  expect(response.status).toBe(503);
});
it("rejects student cookies and an absent content type", async () => {
  const server = app();
  const noType = http("read", JSON.stringify(request("read")));
  noType.headers.delete("content-type");
  expect((await server.fetch(noType)).status).toBe(400);
  h.database.execute("UPDATE marea_users SET role = 'student' WHERE id = 'teacher-1'");
  const forbidden = await server.fetch(http("read", JSON.stringify(request("read"))));
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toEqual({
    protocolVersion: "0.1",
    error: { code: "request.invalid", retryable: false },
  });
});
it("assembles split UTF-8 chunks and releases the stream lock", async () => {
  const server = app();
  const bytes = new TextEncoder().encode(JSON.stringify(request("read")));
  const chunks = [bytes.slice(0, 7), bytes.slice(7, 21), bytes.slice(21)];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const response = await server.fetch(http("read", stream));
  expect(response.status).toBe(200);
  expect(stream.locked).toBe(false);
  const exact = JSON.stringify(request("read")).padEnd(65_536);
  expect((await server.fetch(http("read", exact))).status).toBe(200);
});
it("never calls the service after the streamed body limit is exceeded", async () => {
  const execute = vi.fn(() => ({}));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65_537));
    },
  });
  const response = await app({ execute }).fetch(http("read", stream));
  expect(response.status).toBe(413);
  expect(execute).not.toHaveBeenCalled();
  expect(stream.locked).toBe(false);
});
it("accepts exactly the response byte limit and returns stable non-retryable failures", async () => {
  const result = { value: "x".repeat(262_144 - JSON.stringify({ value: "" }).length) };
  const response = await app({ execute: () => result }).fetch(
    http("read", JSON.stringify(request("read"))),
  );
  expect(response.status).toBe(200);
  expect(new TextEncoder().encode(await response.text())).toHaveLength(262_144);
  for (const [service, status, code] of [
    [null, 503, "server.error"],
    [
      {
        execute: () => {
          throw new Error();
        },
      },
      500,
      "server.error",
    ],
  ] as const) {
    const failure = await app(service).fetch(http("read", JSON.stringify(request("read"))));
    expect(failure.status).toBe(status);
    expect(await failure.json()).toEqual({
      protocolVersion: "0.1",
      error: { code, retryable: false },
    });
  }
});
it("exposes reset and correlates conflicts without making writes retryable", async () => {
  const server = app();
  await server.fetch(http("save", JSON.stringify(write())));
  const conflict = await server.fetch(http("save", JSON.stringify(write())));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    protocolVersion: "0.1",
    requestId: "profile-request",
    error: { code: "request.invalid", retryable: false },
  });
  const reset = request("reset", {
    expectedRevision: "profile-1",
    expectedPersonalRevision: "profile-1",
    catalogRevision: "a".repeat(64),
  });
  const response = await server.fetch(http("reset", JSON.stringify(reset)));
  expect(response.status).toBe(200);
  expect(schemas.state.parse(await response.json()).personal).toMatchObject({
    revision: "profile-2",
    status: "default",
    value: null,
  });
});
it("uses the existing authentication error envelope", async () => {
  const response = await app().fetch(http("read", JSON.stringify(request("read")), { cookie: "" }));
  expect(await response.json()).toEqual({
    protocolVersion: "0.1",
    error: { code: "auth.invalid", retryable: false },
  });
});
it("sanitizes a transaction failure as a correlated non-retryable server error", async () => {
  const server = app();
  h.database.execute(
    "CREATE TRIGGER profile_http_failure BEFORE INSERT ON marea_dashboard_profiles BEGIN SELECT RAISE(ABORT, 'private path'); END",
  );
  const response = await server.fetch(http("save", JSON.stringify(write())));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    protocolVersion: "0.1",
    requestId: "profile-request",
    error: { code: "server.error", retryable: false },
  });
});

it("rejects query parameters on profile operations", async () => {
  const original = http("read", JSON.stringify(request("read")));
  const response = await app().fetch(new Request(`${original.url}?extra=value`, original));
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("requires an Origin header for authenticated profile operations", async () => {
  const input = http("read", JSON.stringify(request("read")));
  input.headers.delete("origin");
  const response = await app().fetch(input);
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("marks only an authenticated host without profile composition as legacy", async () => {
  const server = app(null);
  const missing = await server.fetch(http("read", JSON.stringify(request("read"))));
  expect(missing.status).toBe(503);
  expect(missing.headers.get("x-marea-profile-mode")).toBe("legacy");
  expect(missing.headers.get("cache-control")).toBe("no-store");
  const denied = await server.fetch(http("read", JSON.stringify(request("read")), { cookie: "" }));
  expect(denied.status).toBe(401);
  expect(denied.headers.get("x-marea-profile-mode")).toBeNull();
});
