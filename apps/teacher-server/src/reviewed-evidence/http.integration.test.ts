import { afterEach, expect, it, vi } from "vitest";
vi.mock("bun:sqlite", () => ({
  Database: class {
    readonly mocked = true;
  },
}));
import { ReviewedEvidenceResponseSchema } from "@marea/protocol";
import { evidenceFixture, evidenceQuery, NOW } from "./evidence.fixture.js";
import { usageHealthTestSecurity } from "../usage-health/security.fixture.js";
import { IdentityService } from "../identity/identity-service.js";
import { SqliteIdentityRepository } from "../platform/persistence/sqlite-identity-repository.js";
import { createTeacherProductHttp } from "../product-http/teacher-product-http.boundary.js";
import { createServices, RecordingProvider } from "../product-http/product-http.fixture.js";

let f: ReturnType<typeof evidenceFixture>;
afterEach(() => {
  f.database.close();
  vi.restoreAllMocks();
});
function harness(composed = true) {
  f = evidenceFixture();
  f.approve();
  const identity = new IdentityService({
    repository: new SqliteIdentityRepository(f.database),
    clock: { now: () => NOW },
    ...usageHealthTestSecurity,
  });
  for (const id of ["t1", "t2", "s1"])
    f.database.execute(
      "INSERT INTO marea_auth_sessions VALUES (?1,?1,?1,?2,'2026-09-09T00:00:00.000Z',NULL)",
      [id, NOW],
    );
  const app = createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: ["https://teacher.test"],
    serverVersion: "0.0.0",
    services: {
      ...createServices(new RecordingProvider()),
      identity,
      ...(composed ? { reviewedEvidence: f.service } : {}),
    },
  });
  return { app, identity };
}
function request(
  body: object | string | Uint8Array<ArrayBuffer> = evidenceQuery(),
  path = "students",
  headers: Record<string, string> = {},
) {
  return new Request(`https://teacher.test/api/v1/dashboard/reviewed-evidence/${path}`, {
    method: "POST",
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
    headers: {
      host: "teacher.test",
      origin: "https://teacher.test",
      cookie: "marea_teacher_session=t1",
      "content-type": "application/json",
      ...headers,
    },
  });
}
it("serves bounded authenticated no-store projections through the product router", async () => {
  const { app } = harness();
  for (const query of [
    evidenceQuery(),
    evidenceQuery({ kind: "criteria", studentId: "s1" }),
    evidenceQuery({ kind: "history", studentId: "s1", criterion: f.criterion }),
  ]) {
    const response = await app.fetch(request(query, query.kind));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = ReviewedEvidenceResponseSchema.parse(await response.json());
    expect(result.query).toEqual(query);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(
      /teacherNote|studentFeedback|Private pedagogical|providerRoute/,
    );
  }
});
it("rejects unauthenticated, foreign-class and revoked access regardless of module visibility", async () => {
  const { app, identity } = harness();
  for (const cookie of ["", "marea_teacher_session=t2", "marea_teacher_session=s1"])
    expect(
      (await app.fetch(request(evidenceQuery(), "students", { cookie }))).status,
    ).toBeGreaterThanOrEqual(400);
  expect((await app.fetch(request(evidenceQuery({ classId: "class:two" })))).status).toBe(403);
  for (const headers of [{ origin: "https://foreign.test" }, { host: "foreign.test" }])
    expect(
      (await app.fetch(request(evidenceQuery(), "students", headers))).status,
    ).toBeGreaterThanOrEqual(400);
  const authenticate = identity.authenticate.bind(identity);
  vi.spyOn(identity, "authenticate").mockImplementationOnce((token) => {
    const result = authenticate(token);
    f.database.execute("UPDATE marea_auth_sessions SET revoked_at = ?1", [NOW]);
    return result;
  });
  expect((await app.fetch(request())).status).toBe(401);
});
it("rejects cross-operation input, unknown fields, malformed UTF-8 and oversized streaming bodies", async () => {
  const { app } = harness();
  for (const body of [
    "{",
    new Uint8Array([255]),
    { ...evidenceQuery(), limit: 51 },
    { ...evidenceQuery(), extra: true },
  ])
    expect((await app.fetch(request(body))).status).toBe(400);
  const mismatch = await app.fetch(request(evidenceQuery(), "criteria"));
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({
    error: { code: "request.invalid", retryable: false },
    requestId: "evidence:test",
  });
  expect(
    (await app.fetch(request(" ".repeat(4097), "students", { "content-length": "1" }))).status,
  ).toBe(413);
});
it("reports a missing composition without attempting projection", async () => {
  const { app } = harness(false);
  const response = await app.fetch(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { retryable: false, code: "server.error" },
  });
});
it("sanitizes unexpected storage errors and independently rechecks class authority", async () => {
  const { app } = harness();
  f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
  expect((await app.fetch(request())).status).toBe(403);
  vi.spyOn(f.service, "read").mockImplementation(() => {
    throw new Error("private secret path");
  });
  const failed = await app.fetch(request());
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private");
});
