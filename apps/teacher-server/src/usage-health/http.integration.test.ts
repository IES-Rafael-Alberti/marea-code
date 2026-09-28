import { expect, it, vi } from "vitest";
import { UsageResponseSchema, TeacherHealthResponseSchema } from "@marea/protocol";
import {
  harness,
  useUsageHealthHarness,
  http,
  usageQuery,
  healthQuery,
} from "./usage-health.fixture.js";
const h = useUsageHealthHarness();

it.each([9, 10])(
  "serves authenticated projections on schema %i without migrating or exposing private data",
  async (version) => {
    const target = harness(version);
    try {
      const before = target.database.readAll("SELECT name FROM sqlite_master ORDER BY name");
      target.attempt("a");
      const server = target.app();
      const response = await server.fetch(http(usageQuery()));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(UsageResponseSchema.parse(await response.json())).toMatchObject({
        classId: "class:one",
        requestId: "usage:request",
        entries: [{ attemptId: "a" }],
      });
      const health = await server.fetch(http(healthQuery(), "health/read"));
      expect(health.status).toBe(200);
      const body = TeacherHealthResponseSchema.parse(await health.json());
      expect(body.telemetryDelivery).toEqual({ status: "unknown", observedAt: null });
      expect(JSON.stringify(body)).not.toMatch(/endpoint|credential|provider|run:a|t1|synthetic/);
      expect(target.database.readAll("SELECT name FROM sqlite_master ORDER BY name")).toEqual(
        before,
      );
    } finally {
      target.database.close();
    }
  },
);
it("requires teacher cookies, explicit allowed origin, host and class authority", async () => {
  const server = h().app();
  for (const [headers, status] of [
    [{ cookie: "" }, 401],
    [{ cookie: "marea_teacher_session=s1" }, 403],
    [{ cookie: "marea_teacher_session=t2" }, 403],
    [{ origin: "" }, 403],
    [{ origin: "https://other.test" }, 403],
    [{ host: "other.test" }, 403],
    [{ "content-type": "text/plain" }, 415],
  ] as const)
    expect((await server.fetch(http(usageQuery(), "usage/query", headers))).status).toBe(status);
  expect((await server.fetch(http(usageQuery({ classId: "class:two" })))).status).toBe(403);
  h().database.execute("UPDATE marea_auth_sessions SET revoked_at = '2026-09-07T12:00:00Z'");
  expect((await server.fetch(http(usageQuery()))).status).toBe(401);
});
it("denies newly revoked class membership and cookie revocation during body reads", async () => {
  const server = h().app();
  expect((await server.fetch(http(healthQuery(), "health/read"))).status).toBe(200);
  h().database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
  expect((await server.fetch(http(healthQuery(), "health/read"))).status).toBe(403);
  const authenticate = h().identity.authenticate.bind(h().identity);
  vi.spyOn(h().identity, "authenticate").mockImplementationOnce((token) => {
    const session = authenticate(token);
    h().database.execute("UPDATE marea_auth_sessions SET revoked_at = '2026-09-07T12:00:00Z'");
    return session;
  });
  expect((await server.fetch(http(usageQuery()))).status).toBe(401);
});
it("bounds bytes and strict envelopes, rejects cross-operation payloads and sanitizes failures", async () => {
  const server = h().app();
  for (const body of [
    "{",
    JSON.stringify({ ...usageQuery(), extra: true }),
    JSON.stringify({ ...usageQuery(), limit: 101 }),
    JSON.stringify({ ...usageQuery(), from: "invalid" }),
  ])
    expect((await server.fetch(http(body))).status).toBe(400);
  expect(
    (await server.fetch(http(" ".repeat(2049), "usage/query", { "content-length": "1" }))).status,
  ).toBe(413);
  expect((await server.fetch(http(new Uint8Array([0xff])))).status).toBe(400);
  expect((await server.fetch(http(healthQuery()))).status).toBe(400);
  expect((await server.fetch(http(usageQuery(), "health/read"))).status).toBe(400);
  expect((await h().app(false).fetch(http(usageQuery()))).status).toBe(503);
  vi.spyOn(h().repository, "page").mockImplementation(() => {
    throw new Error("private endpoint credential path");
  });
  const failed = await server.fetch(http(usageQuery()));
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toMatch(/private|endpoint|credential|path/);
});
it("preserves safe error codes, retry semantics and authentication before unavailable composition", async () => {
  const server = h().app();
  for (const [request, status, code] of [
    [http(usageQuery(), "usage/query", { cookie: "" }), 401, "auth.invalid"],
    [http(usageQuery({ classId: "class:two" })), 403, "request.invalid"],
    [http(healthQuery()), 400, "request.invalid"],
  ] as const) {
    const response = await server.fetch(request);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, retryable: false } });
  }
  expect(
    (
      await h()
        .app(false)
        .fetch(http(usageQuery(), "usage/query", { cookie: "" }))
    ).status,
  ).toBe(401);
  expect(await (await h().app(false).fetch(http(usageQuery()))).json()).toMatchObject({
    error: { code: "server.error", retryable: false },
  });
  vi.spyOn(h().repository, "page").mockImplementation(() => {
    throw new Error("private failure");
  });
  expect(await (await server.fetch(http(usageQuery()))).json()).toMatchObject({
    error: { code: "server.error", retryable: false },
  });
});
