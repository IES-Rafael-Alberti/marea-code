import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { registerSessionExportRoutes } from "./session-export-http.boundary.js";
import { SessionExportError, type SessionExportEndpoint } from "../session-export/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import { teacher } from "../../test-support/teaching-integration.fixture.js";

function fixture(service: SessionExportEndpoint | undefined, failure?: Error) {
  const app = new Hono();
  const policy = vi.fn(async (_c, next: () => Promise<void>) => {
    await next();
  });
  const authenticate = vi.fn(() => {
    if (failure) throw failure;
    return teacher;
  });
  registerSessionExportRoutes({ app, policy, authenticate, service });
  const post = (action = "download", body = "{}", json = true) =>
    app.request(`/api/v1/dashboard/session-export/${action}`, {
      method: "POST",
      headers: json ? { "Content-Type": "application/json" } : {},
      body,
    });
  return { post, policy, authenticate };
}
it("guards exports with the dashboard policy and sends a private ZIP or a scoped student list", async () => {
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const service = {
    download: vi.fn(() => bytes),
    students: vi.fn(() => [{ id: "s1", name: "Student", classId: "class:one" }]),
  };
  const f = fixture(service);
  const zip = await f.post("download", '{"identities":"names"}');
  expect(zip.status).toBe(200);
  expect(zip.headers.get("Content-Type")).toBe("application/zip");
  expect(zip.headers.get("Content-Disposition")).toBe('attachment; filename="marea-sessions.zip"');
  expect(zip.headers.get("Cache-Control")).toBe("no-store");
  expect(zip.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(new Uint8Array(await zip.arrayBuffer())).toEqual(bytes);
  expect(service.download).toHaveBeenCalledWith(
    teacher,
    new TextEncoder().encode('{"identities":"names"}'),
  );
  expect(await (await f.post("students")).json()).toEqual({ students: service.students() });
  expect(service.students).toHaveBeenCalledWith(teacher);
  expect(f.policy).toHaveBeenCalledTimes(2);
  expect(f.authenticate).toHaveBeenCalledTimes(2);
});
it("bounds requests and sanitizes permission, availability and internal failures", async () => {
  const download = vi.fn(() => new Uint8Array(0));
  const service = { download, students: () => [] };
  expect((await fixture(service).post("download", "{}", false)).status).toBe(400);
  expect((await fixture(service).post("download", "x".repeat(4097))).status).toBe(413);
  expect(download).not.toHaveBeenCalled();
  expect((await fixture(undefined).post()).status).toBe(503);
  for (const [error, status, code] of [
    [new TeacherDomainError("auth.invalid"), 401, "auth.invalid"],
    [new SessionExportError(403), 403, "request.invalid"],
    [new SessionExportError(413), 413, "request.invalid"],
    [new Error("private-detail"), 500, "server.error"],
  ] as const) {
    const response = await fixture(service, error).post();
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, retryable: false } });
  }
});
