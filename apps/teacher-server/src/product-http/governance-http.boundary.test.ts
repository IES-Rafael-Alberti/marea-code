/* eslint-disable max-lines -- this single boundary suite keeps the full 17-operation matrix together. */
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_GOVERNANCE_REQUEST_BYTES,
  MAX_GOVERNANCE_RESPONSE_BYTES,
  MAX_TEACHING_CONFIGURATION_BYTES,
  RequestIdSchema,
  RevisionIdSchema,
  SkillIdSchema,
  GovernancePreviewClassImportRequestSchema,
  GovernanceConfirmClassImportRequestSchema,
  GovernanceChangeMembershipRequestSchema,
} from "@marea/protocol";

import { exchangePackage, governanceServiceFixture } from "../governance/service.fixture.js";
import type { GovernanceService } from "../governance/contracts.js";
import { GovernanceResourceError } from "../governance/errors.js";
import { SkillSnapshotError } from "../teaching/skills/materialize-skills.js";
import { SqliteGovernanceSessionResolver } from "../platform/persistence/sqlite-governance-session-resolver.js";
import { TeacherDomainError } from "../identity/errors.js";
import { TeachingConfigurationError } from "../teaching/configuration/dashboard-errors.js";
import { createTeacherProductHttp } from "./teacher-product-http.boundary.js";
import { createServices, RecordingProvider } from "./product-http.fixture.js";
import { StoredTeachingConfigurationSchema } from "../teaching/configuration/configuration-schema.js";
import { SqliteTeachingConfigurationRepository } from "../platform/persistence/sqlite-teaching-configuration-repository.js";

const BASE = "https://teacher.test";
const ORIGIN = "https://dashboard.test";
const TOKEN = "admin-cookie-token";
const encoder = new TextEncoder();
type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue;
}

function bodyRequest(
  path: string,
  body: object,
  headers: Record<string, string> = {},
  token = TOKEN,
): Request {
  return new Request(`${BASE}${path}`, {
    body: JSON.stringify(body),
    headers: {
      cookie: `marea_teacher_session=${token}`,
      "content-type": "application/json",
      host: "teacher.test",
      origin: ORIGIN,
      ...headers,
    },
    method: "POST",
  });
}

function envelope(kind: string, requestId = "request:http") {
  return { kind, protocolVersion: "0.1", requestId };
}

type GovernanceFixture = ReturnType<typeof governanceServiceFixture>;

function adminSession(f: GovernanceFixture, sessionId: string, tokenHash = "digest:admin-cookie") {
  f.identities.createSession({
    sessionId,
    userId: "user:admin",
    issuedAt: f.admin.now,
    expiresAt: f.session.expiresAt,
    tokenHash,
  });
}

function governanceHttp(
  f: GovernanceFixture,
  service = f.service,
  digest: (token: string) => string = () => "digest:admin-cookie",
) {
  return createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: [ORIGIN],
    serverVersion: "0.2.0",
    services: createServices(new RecordingProvider()),
    governance: {
      service,
      sessions: new SqliteGovernanceSessionResolver(f.database, f.repository),
      digest: { digest },
      clock: { now: () => f.admin.now },
    },
  });
}

function httpHarness() {
  const f = governanceServiceFixture();
  adminSession(f, "session:http");
  const app = governanceHttp(f);
  return { app, f };
}

function importedClassPackage() {
  return {
    format: "marea-class-exchange:1",
    source: { displayName: "Imported class" },
    agentMode: "free",
    classInstructions: { tutoring: "Imported tutor", free: "Imported free" },
    selection: { didactic: [], evaluation: [] },
  };
}

async function json(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

describe("administrator governance HTTP boundary", () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  it("dispatches all 17 operations through the real SQLite service and cookie resolver", async () => {
    const harness = httpHarness();
    close = () => {
      harness.f.database.close();
    };
    const { app, f } = harness;
    const send = async (path: string, request: object) => {
      const response = await app.fetch(bodyRequest(path, request));
      expect(response.status, `${path} response`).toBe(200);
      return json(response);
    };

    await send("/api/v1/dashboard/governance/access", envelope("governance-access-query"));
    await send("/api/v1/dashboard/governance/centers", {
      ...envelope("governance-centers-query"),
      afterId: null,
    });
    await send("/api/v1/dashboard/governance/classes", {
      ...envelope("governance-classes-query"),
      centerId: "center:a",
      afterId: null,
    });
    await send("/api/v1/dashboard/governance/accounts", {
      ...envelope("governance-accounts-query"),
      centerId: "center:a",
      afterId: null,
    });
    await send("/api/v1/dashboard/governance/memberships", {
      ...envelope("governance-memberships-query"),
      centerId: "center:a",
      classId: "class:a",
      afterId: null,
    });
    const emptyRevision = await send("/api/v1/dashboard/governance/class/revision", {
      ...envelope("governance-class-revision-query"),
      centerId: "center:a",
      classId: "class:a",
    });
    expect(emptyRevision).toEqual({
      ...envelope("governance-class-revision-response"),
      centerId: "center:a",
      classId: "class:a",
      teachingVersion: null,
    });
    const createdClass = await send("/api/v1/dashboard/governance/class/create", {
      ...envelope("governance-class-create"),
      centerId: "center:a",
      classId: "class:http",
      displayName: "HTTP class",
      expectedVersion: null,
    });
    const classVersion = (createdClass.classroom as { version: string }).version;
    const renamedClass = await send("/api/v1/dashboard/governance/class/rename", {
      ...envelope("governance-class-rename"),
      centerId: "center:a",
      classId: "class:http",
      displayName: "Renamed HTTP class",
      expectedVersion: classVersion,
    });
    expect((renamedClass.classroom as { displayName: string }).displayName).toBe(
      "Renamed HTTP class",
    );
    const createdAccount = await send("/api/v1/dashboard/governance/account/create", {
      ...envelope("governance-account-create"),
      centerId: "center:a",
      userId: "user:http",
      displayName: "HTTP teacher",
      login: "http-teacher",
      role: "teacher",
      classId: null,
      expectedVersion: null,
    });
    f.activate("center:a", "user:http");
    const accountVersion = (): string => {
      const row = f.database.readOne(
        "SELECT version FROM marea_governance_accounts WHERE user_id = 'user:http'",
      );
      if (row === undefined || typeof row.version !== "string") throw new Error("missing version");
      return row.version;
    };
    const renamedAccount = await send("/api/v1/dashboard/governance/account/rename", {
      ...envelope("governance-account-rename"),
      centerId: "center:a",
      userId: "user:http",
      displayName: "Renamed HTTP teacher",
      expectedVersion: accountVersion(),
    });
    expect((renamedAccount.account as { displayName: string }).displayName).toBe(
      "Renamed HTTP teacher",
    );
    await send("/api/v1/dashboard/governance/account/state", {
      ...envelope("governance-account-state-change"),
      centerId: "center:a",
      userId: "user:http",
      state: "active",
      expectedVersion: accountVersion(),
    });
    await send("/api/v1/dashboard/governance/membership/change", {
      ...envelope("governance-membership-change"),
      centerId: "center:a",
      classId: "class:http",
      userId: "user:http",
      state: "active",
      expectedVersion: null,
    });
    await send("/api/v1/dashboard/governance/sessions/revoke", {
      ...envelope("governance-sessions-revoke"),
      centerId: "center:a",
      userId: "user:http",
      expectedVersion: accountVersion(),
    });
    const preview = await send("/api/v1/dashboard/governance/class/import/preview", {
      ...envelope("governance-class-import-preview"),
      centerId: "center:a",
      classId: "class:a",
      expectedTeachingVersion: null,
      package: importedClassPackage(),
    });
    const previewId = (preview.preview as { previewId: string }).previewId;
    const confirmed = await send("/api/v1/dashboard/governance/class/import/confirm", {
      ...envelope("governance-class-import-confirm"),
      centerId: "center:a",
      classId: "class:a",
      previewId,
    });
    const teachingVersion = confirmed.teachingVersion as string;
    await send("/api/v1/dashboard/governance/class/export", {
      ...envelope("governance-class-export"),
      centerId: "center:a",
      classId: "class:a",
      expectedTeachingVersion: teachingVersion,
    });
    const secondPreview = await send("/api/v1/dashboard/governance/class/import/preview", {
      ...envelope("governance-class-import-preview", "request:http-1"),
      centerId: "center:a",
      classId: "class:a",
      expectedTeachingVersion: teachingVersion,
      package: importedClassPackage(),
    });
    await send("/api/v1/dashboard/governance/class/import/cancel", {
      ...envelope("governance-class-import-cancel", "request:http-2"),
      centerId: "center:a",
      classId: "class:a",
      previewId: (secondPreview.preview as { previewId: string }).previewId,
    });
    expect(createdAccount.account).toMatchObject({ userId: "user:http", state: "pending" });
  });

  it("enforces policy before body/auth, preserves validated IDs, and applies exact route limits", async () => {
    const harness = httpHarness();
    close = () => {
      harness.f.database.close();
    };
    const { app } = harness;
    const access = envelope("governance-access-query", "request:correlated");
    const mismatch = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/access", {
        ...envelope("governance-centers-query", "request:mismatch"),
        afterId: null,
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await json(mismatch)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
      requestId: "request:mismatch",
    });
    const forbidden = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/access", access, { host: "attacker.test" }),
    );
    expect(forbidden.status).toBe(403);
    const malformedCookie = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/access", access, {
        cookie: "marea_teacher_session=bad token",
      }),
    );
    expect(malformedCookie.status).toBe(401);
    expect(await json(malformedCookie)).toMatchObject({ requestId: "request:correlated" });
    const absentCookie = bodyRequest("/api/v1/dashboard/governance/access", access);
    absentCookie.headers.delete("cookie");
    expect((await app.fetch(absentCookie)).status).toBe(401);
    const badOrigin = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/access", access, {
        origin: "https://attacker.test",
      }),
    );
    expect(badOrigin.status).toBe(403);
    const missingOrigin = bodyRequest("/api/v1/dashboard/governance/access", access);
    missingOrigin.headers.delete("origin");
    const missingOriginResponse = await app.fetch(missingOrigin);
    expect(missingOriginResponse.status).toBe(403);
    expect(await json(missingOriginResponse)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const queryResponse = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/access?unexpected=true", access),
    );
    expect(queryResponse.status).toBe(403);
    expect(await json(queryResponse)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const missingContentType = bodyRequest("/api/v1/dashboard/governance/access", access);
    missingContentType.headers.delete("content-type");
    const missingContentTypeResponse = await app.fetch(missingContentType);
    expect(missingContentTypeResponse.status).toBe(415);
    expect(await json(missingContentTypeResponse)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const duplicateCookie = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/access", access, {
        cookie: `marea_teacher_session=${TOKEN}; marea_teacher_session=${TOKEN}`,
      }),
    );
    expect(duplicateCookie.status).toBe(401);
    const paddedCookie = bodyRequest("/api/v1/dashboard/governance/access", access, {
      cookie: `marea_teacher_session=${TOKEN};${"x".repeat(8_192 - `marea_teacher_session=${TOKEN};`.length)}`,
    });
    expect(paddedCookie.headers.get("cookie")?.length).toBe(8_192);
    expect((await app.fetch(paddedCookie)).status).toBe(200);
    const oversizedCookie = bodyRequest("/api/v1/dashboard/governance/access", access, {
      cookie: `marea_teacher_session=${TOKEN};${"x".repeat(8_193 - `marea_teacher_session=${TOKEN};`.length)}`,
    });
    expect(oversizedCookie.headers.get("cookie")?.length).toBe(8_193);
    expect((await app.fetch(oversizedCookie)).status).toBe(401);
    expect(
      (
        await app.fetch(
          bodyRequest("/api/v1/dashboard/governance/access", access, {
            cookie: "marea_teacher_session=",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          bodyRequest("/api/v1/dashboard/governance/access", access, {
            cookie: `other=x; marea_teacher_session=${TOKEN}`,
          }),
        )
      ).status,
    ).toBe(200);

    const padded = (size: number, prefix = "{") =>
      `${prefix}${" ".repeat(size - encoder.encode(prefix).byteLength)}`;
    const exact = await app.fetch(
      new Request(`${BASE}/api/v1/dashboard/governance/access`, {
        body: padded(MAX_GOVERNANCE_REQUEST_BYTES),
        headers: {
          cookie: `marea_teacher_session=${TOKEN}`,
          "content-type": "application/json",
          host: "teacher.test",
          origin: ORIGIN,
        },
        method: "POST",
      }),
    );
    expect(exact.status).toBe(400);
    expect(await json(exact)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const nextByte = await app.fetch(
      new Request(`${BASE}/api/v1/dashboard/governance/access`, {
        body: padded(MAX_GOVERNANCE_REQUEST_BYTES + 1),
        headers: {
          cookie: `marea_teacher_session=${TOKEN}`,
          "content-type": "application/json",
          host: "teacher.test",
          origin: ORIGIN,
        },
        method: "POST",
      }),
    );
    expect(nextByte.status).toBe(413);
    expect(await json(nextByte)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const malformedNextByte = await app.fetch(
      new Request(`${BASE}/api/v1/dashboard/governance/access`, {
        body: "{" + " ".repeat(MAX_GOVERNANCE_REQUEST_BYTES),
        headers: {
          cookie: `marea_teacher_session=${TOKEN}`,
          "content-type": "application/json",
          host: "teacher.test",
          origin: ORIGIN,
        },
        method: "POST",
      }),
    );
    expect(malformedNextByte.status).toBe(413);
    const invalidUtf8 = await app.fetch(
      new Request(`${BASE}/api/v1/dashboard/governance/access`, {
        body: new Uint8Array([0xff, 0xfe]),
        headers: {
          cookie: `marea_teacher_session=${TOKEN}`,
          "content-type": "application/json",
          host: "teacher.test",
          origin: ORIGIN,
        },
        method: "POST",
      }),
    );
    expect(invalidUtf8.status).toBe(400);
    expect(await json(invalidUtf8)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const malformedJson = await app.fetch(
      new Request(`${BASE}/api/v1/dashboard/governance/access`, {
        body: "{",
        headers: {
          cookie: `marea_teacher_session=${TOKEN}`,
          "content-type": "application/json",
          host: "teacher.test",
          origin: ORIGIN,
        },
        method: "POST",
      }),
    );
    expect(malformedJson.status).toBe(400);
    expect(await json(malformedJson)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const invalidSchema = await app.fetch(bodyRequest("/api/v1/dashboard/governance/access", {}));
    expect(invalidSchema.status).toBe(400);
    expect(await json(invalidSchema)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
    const exchangeNextByte = await app.fetch(
      new Request(`${BASE}/api/v1/dashboard/governance/class/import/confirm`, {
        body: padded(MAX_TEACHING_CONFIGURATION_BYTES + 1),
        headers: {
          cookie: `marea_teacher_session=${TOKEN}`,
          "content-type": "application/json",
          host: "teacher.test",
          origin: ORIGIN,
        },
        method: "POST",
      }),
    );
    expect(exchangeNextByte.status).toBe(413);
    expect(MAX_GOVERNANCE_RESPONSE_BYTES).toBe(262_144);
  });

  it("reads a pre-existing revision for a fresh admin session and preserves export/preview CAS", async () => {
    const f = governanceServiceFixture();
    close = () => {
      f.database.close();
    };
    const imported = await f.service.previewClassImport(
      f.session,
      GovernancePreviewClassImportRequestSchema.parse({
        ...envelope("governance-class-import-preview"),
        centerId: "center:a",
        classId: "class:a",
        expectedTeachingVersion: null,
        package: exchangePackage,
      }),
    );
    const confirmed = await f.service.confirmClassImport(
      f.session,
      GovernanceConfirmClassImportRequestSchema.parse({
        ...envelope("governance-class-import-confirm"),
        centerId: "center:a",
        classId: "class:a",
        previewId: imported.preview.previewId,
      }),
    );
    expect(
      f.database.readAll("SELECT * FROM marea_teacher_classes WHERE teacher_id = 'user:admin'"),
    ).toEqual([]);

    adminSession(f, "session:fresh-admin", "digest:fresh-admin-cookie");
    const app = governanceHttp(f, f.service, (token) => `digest:${token}`);
    const revisionRequest = {
      ...envelope("governance-class-revision-query", "request:readback"),
      centerId: "center:a",
      classId: "class:a",
    };
    const beforeRead = {
      audit: f.database.readAll("SELECT * FROM marea_governance_audit"),
      previews: f.database.readAll("SELECT * FROM marea_class_exchange_previews"),
    };
    const readback = await app.fetch(
      bodyRequest(
        "/api/v1/dashboard/governance/class/revision",
        revisionRequest,
        {},
        "fresh-admin-cookie",
      ),
    );
    expect(readback.status).toBe(200);
    expect(await json(readback)).toEqual({
      ...envelope("governance-class-revision-response", "request:readback"),
      centerId: "center:a",
      classId: "class:a",
      teachingVersion: confirmed.teachingVersion,
    });
    expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(beforeRead.audit);
    expect(f.database.readAll("SELECT * FROM marea_class_exchange_previews")).toEqual(
      beforeRead.previews,
    );
    const missing = await app.fetch(
      bodyRequest(
        "/api/v1/dashboard/governance/class/revision",
        {
          ...envelope("governance-class-revision-query", "request:missing-class"),
          centerId: "center:a",
          classId: "class:missing",
        },
        {},
        "fresh-admin-cookie",
      ),
    );
    const foreign = await app.fetch(
      bodyRequest(
        "/api/v1/dashboard/governance/class/revision",
        {
          ...envelope("governance-class-revision-query", "request:foreign-class"),
          centerId: "center:b",
          classId: "class:b",
        },
        {},
        "fresh-admin-cookie",
      ),
    );
    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect((await json(missing)).error).toEqual((await json(foreign)).error);

    const exported = await app.fetch(
      bodyRequest(
        "/api/v1/dashboard/governance/class/export",
        {
          ...envelope("governance-class-export", "request:readback-export"),
          centerId: "center:a",
          classId: "class:a",
          expectedTeachingVersion: confirmed.teachingVersion,
        },
        {},
        "fresh-admin-cookie",
      ),
    );
    expect(exported.status).toBe(200);
    const preview = await app.fetch(
      bodyRequest(
        "/api/v1/dashboard/governance/class/import/preview",
        {
          ...envelope("governance-class-import-preview", "request:readback-preview"),
          centerId: "center:a",
          classId: "class:a",
          expectedTeachingVersion: confirmed.teachingVersion,
          package: exchangePackage,
        },
        {},
        "fresh-admin-cookie",
      ),
    );
    expect(preview.status).toBe(200);
    const previewPayload = await json(preview);
    expect(previewPayload.preview).toMatchObject({
      expectedTeachingVersion: confirmed.teachingVersion,
    });

    const teacherAccount = f.createAccount("center:a", "user:teacher", "teacher");
    f.activate("center:a", teacherAccount.userId);
    await f.service.changeMembership(
      f.session,
      GovernanceChangeMembershipRequestSchema.parse({
        ...envelope("governance-membership-change"),
        centerId: "center:a",
        classId: "class:a",
        userId: "user:teacher",
        state: "active",
        expectedVersion: null,
      }),
    );
    const teacherRevision = StoredTeachingConfigurationSchema.parse(
      JSON.parse(
        String(
          f.database.readOne(
            "SELECT configuration_json FROM marea_class_teaching_revisions WHERE id = ?1",
            [confirmed.teachingVersion],
          )?.configuration_json,
        ),
      ),
    );
    const changedVersion = "revision:teacher-change";
    const changedConfiguration = StoredTeachingConfigurationSchema.parse({
      ...teacherRevision,
      publicTemplate: {
        ...teacherRevision.publicTemplate,
        prompt: { ...teacherRevision.publicTemplate.prompt, version: changedVersion },
      },
      content: { ...teacherRevision.content, configurationVersion: changedVersion },
    });
    const teacherSessions = new SqliteTeachingConfigurationRepository(f.database);
    teacherSessions.saveRevision({
      teacherId: "user:teacher",
      classId: "class:a",
      expectedVersion: confirmed.teachingVersion,
      configuration: changedConfiguration,
      createdAt: f.admin.now,
    });
    const staleExport = await app.fetch(
      bodyRequest(
        "/api/v1/dashboard/governance/class/export",
        {
          ...envelope("governance-class-export", "request:stale-readback"),
          centerId: "center:a",
          classId: "class:a",
          expectedTeachingVersion: confirmed.teachingVersion,
        },
        {},
        "fresh-admin-cookie",
      ),
    );
    expect(staleExport.status).toBe(409);
    expect(await json(staleExport)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
      requestId: "request:stale-readback",
    });
  });

  it("maps stream, resource, teaching, auth, and unknown failures to sanitized responses", async () => {
    const errors: [Error, number, string, boolean][] = [
      [new GovernanceResourceError(), 413, "request.invalid", false],
      [new TeacherDomainError("auth.invalid"), 401, "auth.invalid", false],
      [new TeacherDomainError("dashboard.forbidden"), 403, "request.invalid", false],
      [new TeacherDomainError("request.conflict"), 409, "request.invalid", false],
      [new TeachingConfigurationError("invalid-request"), 400, "request.invalid", false],
      [new TeachingConfigurationError("operator-unconfigured"), 503, "server.error", false],
      [new TeachingConfigurationError("skill-unavailable"), 422, "request.invalid", false],
      [
        new SkillSnapshotError(SkillIdSchema.parse("teacher/private/missing"), "missing"),
        422,
        "request.invalid",
        false,
      ],
      [new Error("private diagnostic"), 500, "server.error", true],
    ];
    for (const [error, status, code, retryable] of errors) {
      const f = governanceServiceFixture();
      close = () => {
        f.database.close();
      };
      adminSession(f, "session:error");
      const failing: GovernanceService = {
        ...f.service,
        access: () => {
          throw error;
        },
      };
      const app = governanceHttp(f, failing);
      const response = await app.fetch(
        bodyRequest(
          "/api/v1/dashboard/governance/access",
          envelope("governance-access-query", "request:error"),
        ),
      );
      expect(response.status).toBe(status);
      expect(await json(response)).toMatchObject({
        error: { code, retryable },
        requestId: "request:error",
      });
      close = undefined;
      f.database.close();
    }

    const f = governanceServiceFixture();
    close = () => {
      f.database.close();
    };
    adminSession(f, "session:stream");
    const app = governanceHttp(f);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("private stream diagnostic"));
      },
    });
    const streamResponse = await app.fetch(
      new Request(`${BASE}/api/v1/dashboard/governance/access`, {
        body: stream,
        headers: {
          cookie: `marea_teacher_session=${TOKEN}`,
          "content-type": "application/json",
          host: "teacher.test",
          origin: ORIGIN,
        },
        method: "POST",
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(streamResponse.status).toBe(500);
    expect((await json(streamResponse)).error).toEqual({
      code: "server.error",
      retryable: true,
    });
  });

  it("enforces the administrator authority matrix on every operation from live SQLite sessions", async () => {
    const f = governanceServiceFixture();
    close = () => {
      f.database.close();
    };
    const actors = [
      {
        userId: "user:teacher",
        centerId: "center:a",
        role: "teacher" as const,
        token: "teacher-token",
        status: 403,
      },
      {
        userId: "user:foreign",
        centerId: "center:b",
        role: "teacher" as const,
        token: "foreign-token",
        status: 403,
      },
      {
        userId: "user:student",
        centerId: "center:a",
        role: "student" as const,
        token: "student-token",
        status: 403,
      },
      {
        userId: "user:pending",
        centerId: "center:a",
        role: "teacher" as const,
        token: "pending-token",
        status: 401,
      },
      {
        userId: "user:disabled",
        centerId: "center:a",
        role: "teacher" as const,
        token: "disabled-token",
        status: 401,
      },
      {
        userId: "user:expired",
        centerId: "center:a",
        role: "teacher" as const,
        token: "expired-token",
        status: 401,
      },
    ];
    for (const actor of actors) {
      f.createAccount(
        actor.centerId,
        actor.userId,
        actor.role,
        actor.role === "student" ? "class:a" : null,
      );
      if (actor.userId !== "user:pending") f.activate(actor.centerId, actor.userId);
      const sessionId = `session:${actor.userId.slice("user:".length)}`;
      const expiresAt =
        actor.userId === "user:expired" ? "2026-09-12T09:59:59.000Z" : f.session.expiresAt;
      if (actor.userId === "user:pending") {
        // The repository intentionally rejects session issuance for pending
        // accounts; seed this hostile pre-existing row to verify resolution.
        f.database.execute("INSERT INTO marea_auth_sessions VALUES (?1, ?2, ?3, ?4, ?5, NULL)", [
          sessionId,
          actor.userId,
          `digest:${actor.token}`,
          f.admin.now,
          expiresAt,
        ]);
      } else {
        f.identities.createSession({
          sessionId,
          userId: actor.userId,
          issuedAt: f.admin.now,
          expiresAt,
          tokenHash: `digest:${actor.token}`,
        });
      }
    }
    f.database.execute(
      "UPDATE marea_governance_accounts SET state = 'disabled' WHERE user_id = 'user:disabled'",
    );
    const app = governanceHttp(f, f.service, (token) => `digest:${token}`);
    const operations: readonly [string, object][] = [
      ["access", envelope("governance-access-query")],
      ["centers", { ...envelope("governance-centers-query"), afterId: null }],
      ["classes", { ...envelope("governance-classes-query"), centerId: "center:a", afterId: null }],
      [
        "accounts",
        { ...envelope("governance-accounts-query"), centerId: "center:a", afterId: null },
      ],
      [
        "memberships",
        {
          ...envelope("governance-memberships-query"),
          centerId: "center:a",
          classId: "class:a",
          afterId: null,
        },
      ],
      [
        "class/revision",
        {
          ...envelope("governance-class-revision-query"),
          centerId: "center:a",
          classId: "class:a",
        },
      ],
      [
        "class/create",
        {
          ...envelope("governance-class-create"),
          centerId: "center:a",
          classId: "class:matrix",
          displayName: "Matrix",
          expectedVersion: null,
        },
      ],
      [
        "class/rename",
        {
          ...envelope("governance-class-rename"),
          centerId: "center:a",
          classId: "class:missing",
          displayName: "Matrix",
          expectedVersion: "revision:missing",
        },
      ],
      [
        "account/create",
        {
          ...envelope("governance-account-create"),
          centerId: "center:a",
          userId: "user:matrix",
          displayName: "Matrix",
          login: "matrix",
          role: "teacher",
          classId: null,
          expectedVersion: null,
        },
      ],
      [
        "account/rename",
        {
          ...envelope("governance-account-rename"),
          centerId: "center:a",
          userId: "user:missing",
          displayName: "Matrix",
          expectedVersion: "revision:missing",
        },
      ],
      [
        "account/state",
        {
          ...envelope("governance-account-state-change"),
          centerId: "center:a",
          userId: "user:missing",
          state: "disabled",
          expectedVersion: "revision:missing",
        },
      ],
      [
        "membership/change",
        {
          ...envelope("governance-membership-change"),
          centerId: "center:a",
          classId: "class:a",
          userId: "user:missing",
          state: "active",
          expectedVersion: null,
        },
      ],
      [
        "sessions/revoke",
        {
          ...envelope("governance-sessions-revoke"),
          centerId: "center:a",
          userId: "user:missing",
          expectedVersion: "revision:missing",
        },
      ],
      [
        "class/export",
        {
          ...envelope("governance-class-export"),
          centerId: "center:a",
          classId: "class:a",
          expectedTeachingVersion: "revision:missing",
        },
      ],
      [
        "class/import/preview",
        {
          ...envelope("governance-class-import-preview"),
          centerId: "center:a",
          classId: "class:a",
          expectedTeachingVersion: null,
          package: {
            format: "marea-class-exchange:1",
            source: { displayName: "Matrix" },
            agentMode: "free",
            classInstructions: { tutoring: "Matrix", free: "Matrix" },
            selection: { didactic: [], evaluation: [] },
          },
        },
      ],
      [
        "class/import/confirm",
        {
          ...envelope("governance-class-import-confirm"),
          centerId: "center:a",
          classId: "class:a",
          previewId: "preview:missing",
        },
      ],
      [
        "class/import/cancel",
        {
          ...envelope("governance-class-import-cancel"),
          centerId: "center:a",
          classId: "class:a",
          previewId: "preview:missing",
        },
      ],
    ];
    for (const actor of actors) {
      for (const [path, request] of operations) {
        const response = await app.fetch(
          bodyRequest(`/api/v1/dashboard/governance/${path}`, request, {}, actor.token),
        );
        expect(response.status, `${actor.userId} ${path}`).toBe(actor.status);
        const result = await json(response);
        expect(result).not.toHaveProperty("stack");
        expect(JSON.stringify(result)).not.toContain(actor.token);
        if (actor.status === 401) {
          expect(result).toMatchObject({ error: { code: "auth.invalid", retryable: false } });
        }
      }
    }
  });

  it("fails closed when governance composition is absent", async () => {
    const app = createTeacherProductHttp({
      allowedHosts: ["teacher.test"],
      allowedOrigins: [ORIGIN],
      serverVersion: "0.2.0",
      services: createServices(new RecordingProvider()),
    });
    expect(
      (
        await app.fetch(
          bodyRequest("/api/v1/dashboard/governance/access", envelope("governance-access-query")),
        )
      ).status,
    ).toBe(404);
  });

  it("rejects response payloads over their route boundary without exposing extras", async () => {
    const f = governanceServiceFixture();
    close = () => {
      f.database.close();
    };
    adminSession(f, "session:response");
    const huge = "x".repeat(MAX_GOVERNANCE_RESPONSE_BYTES);
    const responseBase = {
      kind: "governance-access-response" as const,
      protocolVersion: "0.1" as const,
      requestId: RequestIdSchema.parse("request:response"),
      access: { administrator: true as const },
    };
    const responseOverhead = encoder.encode(
      JSON.stringify({ ...responseBase, huge: "" }),
    ).byteLength;
    const exactHuge = "x".repeat(MAX_GOVERNANCE_RESPONSE_BYTES - responseOverhead);
    const centersResponseBase = {
      kind: "governance-centers-response" as const,
      protocolVersion: "0.1" as const,
      requestId: RequestIdSchema.parse("request:response-centers"),
      items: [],
      nextAfterId: null,
    };
    const service = {
      ...f.service,
      access: () => Promise.resolve({ ...responseBase, huge: exactHuge }),
      centers: () => Promise.resolve({ ...centersResponseBase, huge }),
    } satisfies GovernanceService;
    const app = governanceHttp(f, service);
    const exactResponse = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/access", envelope("governance-access-query")),
    );
    expect(exactResponse.status).toBe(200);
    const response = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/centers", {
        ...envelope("governance-centers-query"),
        afterId: null,
      }),
    );
    expect(response.status).toBe(413);
    expect(await json(response)).toMatchObject({
      error: { code: "request.invalid", retryable: false },
    });
  });

  it("uses only the validated stored session metadata, including expiry and revocation", async () => {
    const harness = httpHarness();
    close = () => {
      harness.f.database.close();
    };
    const { app, f } = harness;
    const valid = await app.fetch(
      bodyRequest("/api/v1/dashboard/governance/access", envelope("governance-access-query")),
    );
    expect(valid.status).toBe(200);
    f.database.execute(
      "UPDATE marea_auth_sessions SET revoked_at = issued_at WHERE id = 'session:http'",
    );
    expect(
      (
        await app.fetch(
          bodyRequest("/api/v1/dashboard/governance/access", envelope("governance-access-query")),
        )
      ).status,
    ).toBe(401);
    expect(RevisionIdSchema.parse("session:http")).toBe("session:http");
    expect(RequestIdSchema.parse("request:http")).toBe("request:http");
  });
});
