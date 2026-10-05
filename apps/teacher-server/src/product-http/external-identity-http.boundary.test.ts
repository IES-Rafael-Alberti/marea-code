import {
  SessionTokenSchema,
  type ExternalAccessRequest,
  type ExternalAuthBeginRequest,
  type ExternalAuthCompleteRequest,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { ExternalIdentityServices } from "./contracts.js";
import {
  capabilitiesRequest,
  createApplication,
  createServices,
  RecordingProvider,
  request,
  SESSION_TOKEN,
  TEACHER_TOKEN,
} from "./product-http.fixture.js";

const envelope = { protocolVersion: "0.1" } as const;
const session = {
  token: SessionTokenSchema.parse("t".repeat(43)),
  issuedAt: "2026-10-05T10:00:00.000Z",
  expiresAt: "2026-10-05T10:30:00.000Z",
};

function external(enabled = true) {
  const seen: {
    access: [AuthenticatedIdentity, ExternalAccessRequest][];
    begun: ExternalAuthBeginRequest[];
    completed: ExternalAuthCompleteRequest[];
  } = {
    access: [],
    begun: [],
    completed: [],
  };
  const services: ExternalIdentityServices = {
    signIn: {
      enabled: () => enabled,
      providers: (query) => ({
        kind: "external-auth-providers",
        ...envelope,
        requestId: query.requestId,
        providers: [],
      }),
      begin: (begin) => {
        seen.begun.push(begin);
        if (begin.providerId !== "org.example.idp")
          throw new TeacherDomainError("request.conflict");
        return {
          kind: "external-auth-started",
          ...envelope,
          requestId: begin.requestId,
          flowId: "f".repeat(32),
          authorizationUrl: "https://idp.test/auth",
          expiresAt: "2026-10-05T10:10:00.000Z",
        };
      },
      complete: (complete) => {
        seen.completed.push(complete);
        if (complete.code === "bad") return Promise.reject(new TeacherDomainError("auth.invalid"));
        return Promise.resolve({
          kind: "external-authenticated",
          ...envelope,
          requestId: complete.requestId,
          principal: { role: "student", displayName: "Ana" },
          session,
        });
      },
    },
    access: {
      execute: (identity, body) => {
        seen.access.push([identity, body]);
        return {
          kind: "external-access",
          ...envelope,
          requestId: body.requestId,
          classId: body.classId,
          providers: [],
          rules: [],
          rejected: [],
        };
      },
    },
  };
  return { services, seen };
}

const dashboard = (body: object, cookie?: string) =>
  request("/api/v1/dashboard/external-access", body, undefined, {
    origin: "https://dashboard.test",
    ...(cookie === undefined ? {} : { cookie: `marea_teacher_session=${cookie}` }),
  });

const accessQuery = {
  kind: "external-access-query",
  ...envelope,
  requestId: "r:access",
  classId: "class:physics",
};

describe("external identity HTTP routes", () => {
  it("serves student sign-in and teacher access, announcing the capability", async () => {
    const test = external();
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      externalIdentity: test.services,
    });
    const capabilities = (await (
      await app.fetch(request("/v1/capabilities", capabilitiesRequest))
    ).json()) as { capabilities: string[] };
    expect(capabilities.capabilities).toContain("marea.auth.external");
    const providers = await app.fetch(
      request("/v1/auth/external/providers", {
        kind: "external-auth-providers-query",
        ...envelope,
        requestId: "r:providers",
      }),
    );
    expect(await providers.json()).toMatchObject({
      kind: "external-auth-providers",
      requestId: "r:providers",
    });
    const begin = {
      kind: "external-auth-begin",
      ...envelope,
      requestId: "r:begin",
      providerId: "org.example.idp",
      redirectUri: "http://127.0.0.1:4321/callback",
    };
    const started = await app.fetch(request("/v1/auth/external/begin", begin));
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ flowId: "f".repeat(32) });
    expect(
      (
        await app.fetch(
          request("/v1/auth/external/begin", { ...begin, providerId: "org.example.x" }),
        )
      ).status,
    ).toBe(409);
    const complete = {
      kind: "external-auth-complete",
      ...envelope,
      requestId: "r:complete",
      flowId: "f".repeat(32),
      state: "s".repeat(32),
      code: "4/code",
    };
    const completed = await app.fetch(request("/v1/auth/external/complete", complete));
    expect(await completed.json()).toMatchObject({ kind: "external-authenticated", session });
    expect(completed.headers.get("set-cookie")).toBeNull();
    const denied = await app.fetch(
      request("/v1/auth/external/complete", { ...complete, code: "bad" }),
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ requestId: "r:complete" });
    const access = await app.fetch(dashboard(accessQuery, TEACHER_TOKEN));
    expect(await access.json()).toMatchObject({
      kind: "external-access",
      classId: "class:physics",
    });
    expect(test.seen.access[0]?.[0]).toMatchObject({ role: "teacher" });
  });

  it("validates every body and protects teacher access with the dashboard session", async () => {
    const test = external();
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      externalIdentity: test.services,
    });
    for (const path of [
      "/v1/auth/external/providers",
      "/v1/auth/external/begin",
      "/v1/auth/external/complete",
    ])
      expect((await app.fetch(request(path, {}))).status).toBe(400);
    expect((await app.fetch(dashboard({}, TEACHER_TOKEN))).status).toBe(400);
    const searched = dashboard(accessQuery, TEACHER_TOKEN);
    expect((await app.fetch(new Request(`${searched.url}?x=1`, searched))).status).toBe(403);
    expect((await app.fetch(dashboard(accessQuery))).status).toBe(401);
    expect((await app.fetch(dashboard(accessQuery, SESSION_TOKEN))).status).toBe(403);
    expect(
      (
        await app.fetch(
          request("/api/v1/dashboard/external-access", accessQuery, undefined, {
            cookie: `marea_teacher_session=${TEACHER_TOKEN}`,
          }),
        )
      ).status,
    ).toBe(403);
    expect(test.seen.access).toEqual([]);
    expect(test.seen.begun).toEqual([]);
    expect(test.seen.completed).toEqual([]);
  });

  it("offers nothing without configured providers or usable storage", async () => {
    const disabled = createApplication({
      ...createServices(new RecordingProvider()),
      externalIdentity: external(false).services,
    });
    const capabilities = (await (
      await disabled.fetch(request("/v1/capabilities", capabilitiesRequest))
    ).json()) as { capabilities: string[] };
    expect(capabilities.capabilities).not.toContain("marea.auth.external");
    const absent = createApplication(createServices(new RecordingProvider()));
    expect(
      (
        await absent.fetch(
          request("/v1/auth/external/providers", {
            kind: "external-auth-providers-query",
            ...envelope,
            requestId: "r:providers",
          }),
        )
      ).status,
    ).toBe(404);
    expect((await absent.fetch(dashboard(accessQuery, TEACHER_TOKEN))).status).toBe(404);
  });
});
