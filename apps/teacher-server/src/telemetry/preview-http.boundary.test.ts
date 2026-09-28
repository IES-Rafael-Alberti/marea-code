import { RequestPolicy } from "@marea/transport-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryPreviewResponseSchema, TELEMETRY_PREVIEW_PATH } from "@marea/protocol";
import { createOperationalTelemetry, type TelemetryEnvelope } from "@marea/telemetry-pipeline";
import { previewFixture, previewHttpRequest, previewRequest, origin } from "./preview.fixture.js";
import { createTelemetryPreviewHttp } from "./preview-http.boundary.js";
import { TeacherDomainError } from "../identity/errors.js";

const fixtures: ReturnType<typeof previewFixture>[] = [];
function fixture(telemetry?: Parameters<typeof previewFixture>[0]) {
  const f = previewFixture(telemetry);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.database.close();
  vi.restoreAllMocks();
});

describe("authenticated telemetry preview", () => {
  it("authenticates a real SQLite cookie and previews an enabled runtime with zero outbound or lifecycle calls", async () => {
    const exportSpy = vi
      .fn<(envelope: TelemetryEnvelope, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue();
    const shutdown = vi.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue();
    const runtime = createOperationalTelemetry(
      { enabled: true, destinations: ["otlp", "langfuse"], maxInFlight: 1, operationTimeoutMs: 1 },
      {
        otlp: { id: "secret-endpoint-otlp", export: exportSpy, shutdown },
        langfuse: { id: "secret-endpoint-langfuse", export: exportSpy, shutdown },
      },
    );
    const f = fixture(runtime);
    const cookie = await f.cookie();
    const writes = vi.spyOn(f.database, "execute");
    const response = await f.app.fetch(previewHttpRequest(cookie));
    expect(writes).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toMatch(/secret|student|actor|synthetic-sensitive/);
    const result = TelemetryPreviewResponseSchema.parse(JSON.parse(text));
    expect(result).toMatchSnapshot();
    expect(exportSpy).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(runtime.configuration).toEqual({ enabled: true, destinationCount: 2 });
  });

  it("denies missing/forged cookies, students, other teachers/classes and revocation", async () => {
    const f = fixture();
    expect((await f.app.fetch(previewHttpRequest(""))).status).toBe(401);
    expect((await f.app.fetch(previewHttpRequest("marea_teacher_session=forged"))).status).toBe(
      401,
    );
    expect((await f.app.fetch(previewHttpRequest(await f.cookie("s1")))).status).toBe(403);
    expect((await f.app.fetch(previewHttpRequest(await f.cookie("t2")))).status).toBe(403);
    const cookie = await f.cookie();
    expect(
      (await f.app.fetch(previewHttpRequest(cookie, { ...previewRequest, classId: "class:two" })))
        .status,
    ).toBe(403);
    f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
    expect((await f.app.fetch(previewHttpRequest(cookie))).status).toBe(403);
    f.database.execute("UPDATE marea_auth_sessions SET revoked_at = '2026-09-22T09:00:00.000Z'");
    expect((await f.app.fetch(previewHttpRequest(cookie))).status).toBe(401);
  });

  it("denies adopted classes without current center membership despite a stale legacy join", async () => {
    const f = fixture();
    const cookie = await f.cookie();
    const now = "2026-09-22T10:00:00.000Z";
    f.database.execute(
      "INSERT INTO marea_centers VALUES ('center:preview', 'Preview', 'v1', ?1, ?1)",
      [now],
    );
    f.database.execute(
      "INSERT INTO marea_governance_classes VALUES ('class:one', 'center:preview', 'v1', ?1, ?1)",
      [now],
    );
    expect((await f.app.fetch(previewHttpRequest(cookie))).status).toBe(403);
    f.database.execute(
      "INSERT INTO marea_governance_accounts VALUES ('t1', 'center:preview', 'active', 'v1', ?1, ?1)",
      [now],
    );
    f.database.execute(
      "INSERT INTO marea_center_memberships VALUES ('center:preview', 't1', 'member', 'active', 'v1', ?1, ?1)",
      [now],
    );
    f.database.execute(
      "INSERT INTO marea_governance_memberships VALUES ('class:one', 'center:preview', 't1', 'teacher', 'active', 'v1', ?1, ?1)",
      [now],
    );
    expect((await f.app.fetch(previewHttpRequest(cookie))).status).toBe(200);
    f.database.execute(
      "UPDATE marea_center_memberships SET state = 'revoked' WHERE user_id = 't1'",
    );
    expect((await f.app.fetch(previewHttpRequest(cookie))).status).toBe(403);
  });

  it("requires teacher role before checking membership, for non-teachers", () => {
    const f = fixture();
    const membership = vi.spyOn(f.database, "readOne");
    expect(() =>
      f.service.preview(
        { role: "student", userId: "admin", displayName: "Admin", classId: null },
        previewRequest,
      ),
    ).toThrow(new TeacherDomainError("dashboard.forbidden"));
    expect(membership).not.toHaveBeenCalled();
  });

  it("requires host/origin and disallows query, forged fields, oversized UTF-8 and wrong media type", async () => {
    const f = fixture();
    const cookie = await f.cookie();
    for (const headers of [
      { origin: "https://evil.test" },
      { origin: "" },
      { host: "evil.test" },
    ]) {
      expect((await f.app.fetch(previewHttpRequest(cookie, previewRequest, headers))).status).toBe(
        403,
      );
    }
    const noOrigin = previewHttpRequest(cookie);
    noOrigin.headers.delete("origin");
    const denied = await f.app.fetch(noOrigin);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const query = new Request(
      `https://teacher.test${TELEMETRY_PREVIEW_PATH}?secret=1`,
      previewHttpRequest(cookie),
    );
    expect((await f.app.fetch(query)).status).toBe(403);
    expect(
      (await f.app.fetch(previewHttpRequest(cookie, { ...previewRequest, enabled: true }))).status,
    ).toBe(400);
    expect(
      (
        await f.app.fetch(
          previewHttpRequest(cookie, { ...previewRequest, classId: "é".repeat(1100) }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await f.app.fetch(
          previewHttpRequest(cookie, previewRequest, { "content-type": "text/plain" }),
        )
      ).status,
    ).toBe(415);
    const missing = await f.app.fetch(new Request(`https://teacher.test${TELEMETRY_PREVIEW_PATH}`));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
  });

  it("sanitizes thrown service errors and framework errors", async () => {
    const f = fixture();
    const cookie = await f.cookie();
    const app = createTelemetryPreviewHttp({
      allowedHosts: ["teacher.test"],
      allowedOrigins: [origin],
      identity: f.identity,
      service: {
        preview: () => {
          throw new Error("secret endpoint credentials");
        },
      },
    });
    const result = await app.fetch(previewHttpRequest(cookie));
    expect(result.status).toBe(500);
    expect(await result.text()).not.toContain("secret");
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("secret"));
      },
    });
    const failingRequest = new Request(`https://teacher.test${TELEMETRY_PREVIEW_PATH}`, {
      method: "POST",
      headers: { host: "teacher.test", origin, cookie, "content-type": "application/json" },
      body: broken,
      duplex: "half",
    } as RequestInit);
    const error = await f.app.fetch(failingRequest);
    expect(error.status).toBe(500);
    expect(await error.text()).not.toContain("secret");
  });
  it("returns a fixed error if transport evaluation unexpectedly throws", async () => {
    const f = fixture();
    vi.spyOn(RequestPolicy.prototype, "evaluate").mockImplementation(() => {
      throw new Error("secret");
    });
    const result = await f.app.fetch(previewHttpRequest(""));
    expect(result.status).toBe(500);
    expect(await result.json()).toMatchObject({ error: { code: "server.error", retryable: true } });
  });
});
