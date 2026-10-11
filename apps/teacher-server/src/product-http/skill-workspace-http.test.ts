import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { SKILL_WORKSPACE_PATH, SkillWorkspaceResponseSchema, SkillIdSchema } from "@marea/protocol";
import { skillAssignmentFixture } from "../platform/persistence/skill-assignments.fixture.js";
import { registerSkillWorkspaceRoutes } from "./skill-workspace-http.boundary.js";
import { TeacherDomainError } from "../identity/errors.js";
import { SkillSnapshotError } from "../teaching/skills/index.js";

function fixture(unavailable = false) {
  const f = skillAssignmentFixture();
  const app = new Hono();
  const authenticate = vi.fn(() => f.teacher);
  registerSkillWorkspaceRoutes({
    app,
    service: unavailable ? undefined : f.service,
    authenticate,
    policy: async (context, next) => {
      if (context.req.header("origin") !== "http://teacher.test")
        return new Response("origin", { status: 403 });
      await next();
      return context.res;
    },
  });
  const request = (body: object | string, headers: Readonly<Record<string, string>> = {}) =>
    app.request(SKILL_WORKSPACE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://teacher.test", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { ...f, request, authenticate };
}
it("authenticates and returns the bounded workspace response through the HTTP adapter", async () => {
  const f = fixture();
  const response = await f.request({
    protocolVersion: "0.1",
    requestId: "request:read",
    classId: "class:one",
    kind: "students",
    after: null,
  });
  expect(response.status).toBe(200);
  expect(SkillWorkspaceResponseSchema.parse(await response.json())).toMatchObject({
    kind: "students",
    requestId: "request:read",
    students: [{ displayName: "Ana" }, { displayName: "Pablo" }],
    next: null,
  });
  expect(f.authenticate).toHaveBeenCalledOnce();
});
it("rejects missing services, invalid media, malformed schemas, excessive bodies and forbidden origins", async () => {
  const missing = await fixture(true).request({});
  expect(missing.status).toBe(503);
  expect(await missing.json()).toMatchObject({ error: { code: "server.error", retryable: false } });
  const f = fixture();
  expect((await f.request({})).status).toBe(400);
  expect((await f.request("{")).status).toBe(400);
  expect((await f.request({}, { "content-type": "text/plain" })).status).toBe(415);
  expect((await f.request("x".repeat(131073))).status).toBe(413);
  expect((await f.request({}, { origin: "http://other.test" })).status).toBe(403);
});
it("sanitizes authorization, stale assignment and unexpected failures", async () => {
  const f = fixture();
  for (const [error, status] of [
    [new TeacherDomainError("auth.invalid"), 401],
    [new TeacherDomainError("dashboard.forbidden"), 403],
    [new TeacherDomainError("request.conflict"), 409],
    [new Error("private database path"), 500],
  ] as const) {
    f.authenticate.mockImplementationOnce(() => {
      throw error;
    });
    const response = await f.request({});
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      protocolVersion: "0.1",
      error: {
        code: status === 500 ? "server.error" : status === 409 ? "request.invalid" : "auth.invalid",
        retryable: false,
      },
    });
  }
  f.authenticate.mockImplementationOnce(() => {
    throw new SkillSnapshotError(SkillIdSchema.parse("marea/testing"), "missing");
  });
  const snapshot = await f.request({});
  expect(snapshot.status).toBe(409);
  expect(await snapshot.json()).toMatchObject({
    error: { code: "request.invalid", retryable: false },
  });
});
