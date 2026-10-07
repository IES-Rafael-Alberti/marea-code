import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { registerServerSettingsRoutes } from "./server-settings-http.boundary.js";
import { ServerSettingsError } from "../server-settings/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
const path = "/api/v1/dashboard/server-settings";
it("uses the dashboard policy and authenticated identity before parsing bounded input", async () => {
  const app = new Hono();
  const identity = {
    userId: "user:owner",
    role: "teacher" as const,
    displayName: "Owner",
    classId: null,
  };
  const execute = vi.fn().mockReturnValue({ administrator: false, initialized: false });
  const policy = vi.fn(async (_context, next: () => Promise<void>) => {
    await next();
  });
  registerServerSettingsRoutes({ app, authenticate: () => identity, policy, service: { execute } });
  const response = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"operation":"read"}',
  });
  expect(response.status).toBe(200);
  expect(policy).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith(
    identity,
    new TextEncoder().encode('{"operation":"read"}'),
    expect.any(AbortSignal),
  );
  expect(await response.json()).toEqual({ administrator: false, initialized: false });
  const invalid = await app.request(path, { method: "POST", body: "{}" });
  expect(invalid.status).toBe(400);
  expect(execute).toHaveBeenCalledOnce();
});
/** Posts to a route whose authentication or service fails with the given error. */
function failing(failure: Error) {
  const app = new Hono();
  registerServerSettingsRoutes({
    app,
    policy: async (_c, next) => {
      await next();
    },
    authenticate: () => {
      if (failure instanceof TeacherDomainError) throw failure;
      return { userId: "user:owner", role: "teacher", displayName: "Owner", classId: null };
    },
    service: {
      execute: () => {
        throw failure;
      },
    },
  });
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}
it.each([400, 403, 409, 503])(
  "returns a bounded error without leaking credentials (%i)",
  async (status) => {
    const response = await failing(new ServerSettingsError(status));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("Server settings request failed");
  },
);
it("rejects expired authentication before executing the settings service", async () => {
  const app = new Hono();
  const execute = vi.fn();
  registerServerSettingsRoutes({
    app,
    policy: async (_c, next) => {
      await next();
    },
    authenticate: () => {
      throw new TeacherDomainError("auth.invalid");
    },
    service: { execute },
  });
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect(execute).not.toHaveBeenCalled();
});
it("reports a missing service, an oversized body and unexpected failures without detail", async () => {
  const identity = {
    userId: "user:owner",
    role: "teacher" as const,
    displayName: "Owner",
    classId: null,
  };
  const post = (
    service: Parameters<typeof registerServerSettingsRoutes>[0]["service"],
    body = "{}",
  ) => {
    const app = new Hono();
    registerServerSettingsRoutes({
      app,
      policy: async (_c, next) => {
        await next();
      },
      authenticate: () => identity,
      service,
    });
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  };
  expect((await post(undefined)).status).toBe(503);
  const execute = vi.fn();
  const oversized = await post({ execute }, `{"padding":"${"x".repeat(262144)}"}`);
  expect(oversized.status).toBeGreaterThanOrEqual(400);
  expect(execute).not.toHaveBeenCalled();
  const failed = await post({
    execute: () => {
      throw new Error("synthetic-internal-detail");
    },
  });
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("synthetic-internal-detail");
});
it.each([
  [new TeacherDomainError("auth.invalid"), 401, "auth.invalid"],
  [new ServerSettingsError(400), 400, "request.invalid"],
  [new ServerSettingsError(409), 409, "request.invalid"],
  [new ServerSettingsError(503), 503, "server.error"],
  [new Error("synthetic-internal-detail"), 500, "server.error"],
])("maps %s to a closed, non-retryable code", async (failure, status, code) => {
  const response = await failing(failure);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code, retryable: false } });
});
