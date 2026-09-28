import { describe, expect, it } from "vitest";

import {
  CredentialLoginRequestSchema,
  CredentialLoginResponseSchema,
  CredentialLoginSchema,
  CredentialLogoutRequestSchema,
  CredentialLogoutResponseSchema,
  CredentialPasswordSchema,
  DashboardSessionQuerySchema,
  DashboardSessionResponseSchema,
  EnrollStudentRequestSchema,
  EnrollStudentResponseSchema,
  PrincipalRoleSchema,
  SafePrincipalSchema,
  SafeStudentPrincipalSchema,
} from "./auth.js";

const credentials = { login: "ana.student", password: "correct-horse-battery" } as const;
const session = {
  token: "session_token_with_at_least_thirty_two_chars",
  issuedAt: "2026-09-03T10:00:00Z",
  expiresAt: "2026-09-03T11:00:00Z",
} as const;

const enrollmentRequest = {
  kind: "student-invitation-enrollment",
  protocolVersion: "0.1",
  requestId: "request-enroll-1",
  invitationCode: "class_invite_1234",
  displayName: "Ana María",
  credentials,
} as const;

describe("authentication protocol", () => {
  it("enrolls an invited student without accepting authority identifiers", () => {
    const request = EnrollStudentRequestSchema.parse(enrollmentRequest);
    const response = EnrollStudentResponseSchema.parse({
      kind: "student-invitation-enrolled",
      protocolVersion: "0.1",
      requestId: request.requestId,
      principal: { role: "student", displayName: request.displayName },
      session,
    });

    expect(response).toMatchObject({
      kind: "student-invitation-enrolled",
      principal: { role: "student", displayName: "Ana María" },
    });
    expect(Object.isFrozen(response.principal)).toBe(true);
  });

  it.each(["studentId", "classId", "role", "permissions"])(
    "rejects enrollment authority field %s",
    (field) => {
      expect(() =>
        EnrollStudentRequestSchema.parse({ ...enrollmentRequest, [field]: "forged" }),
      ).toThrow();
    },
  );

  it("authenticates either safe principal role and logs out", () => {
    const request = CredentialLoginRequestSchema.parse({
      kind: "credential-login",
      protocolVersion: "0.1",
      requestId: "request-login-1",
      credentials,
    });
    const response = CredentialLoginResponseSchema.parse({
      kind: "credential-authenticated",
      protocolVersion: "0.1",
      requestId: request.requestId,
      principal: { role: "teacher", displayName: "Ada Lovelace" },
      session,
    });
    const logoutRequest = CredentialLogoutRequestSchema.parse({
      kind: "credential-logout",
      protocolVersion: "0.1",
      requestId: "request-logout-1",
    });
    const logoutResponse = CredentialLogoutResponseSchema.parse({
      kind: "credential-logged-out",
      protocolVersion: "0.1",
      requestId: logoutRequest.requestId,
      loggedOutAt: "2026-09-03T10:30:00Z",
      alreadyLoggedOut: false,
    });

    expect(response.principal.role).toBe("teacher");
    expect(logoutResponse.alreadyLoggedOut).toBe(false);
  });

  it.each(["student", "teacher"])("accepts safe principal role %s", (role) => {
    expect(PrincipalRoleSchema.parse(role)).toBe(role);
  });

  it("rejects private principal and session fields", () => {
    expect(() =>
      SafePrincipalSchema.parse({ role: "student", displayName: "Ana", studentId: "private" }),
    ).toThrow();
    expect(() =>
      SafeStudentPrincipalSchema.parse({ role: "teacher", displayName: "Ana" }),
    ).toThrow();
    expect(() =>
      CredentialLoginResponseSchema.parse({
        kind: "credential-authenticated",
        protocolVersion: "0.1",
        requestId: "request-login-1",
        principal: { role: "student", displayName: "Ana" },
        session: { ...session, refreshToken: "private" },
      }),
    ).toThrow();
  });

  it("enforces credential boundaries", () => {
    expect(CredentialLoginSchema.parse("abc")).toBe("abc");
    expect(CredentialLoginSchema.parse("a".repeat(64))).toHaveLength(64);
    expect(CredentialPasswordSchema.parse("a".repeat(12))).toHaveLength(12);
    expect(CredentialPasswordSchema.parse("a".repeat(256))).toHaveLength(256);
    expect(() => CredentialLoginSchema.parse("ab")).toThrow();
    expect(() => CredentialLoginSchema.parse("a".repeat(65))).toThrow();
    expect(() => CredentialLoginSchema.parse("Ana Student")).toThrow();
    expect(() => CredentialLoginSchema.parse("student!")).toThrow();
    expect(() => CredentialPasswordSchema.parse("a".repeat(11))).toThrow();
    expect(() => CredentialPasswordSchema.parse("a".repeat(257))).toThrow();
  });

  it("requires an authentication session to expire after issue", () => {
    const expired = EnrollStudentResponseSchema.safeParse({
      kind: "student-invitation-enrolled",
      protocolVersion: "0.1",
      requestId: "request-enroll-1",
      principal: { role: "student", displayName: "Ana" },
      session: { ...session, expiresAt: session.issuedAt },
    });

    expect(expired).toMatchObject({
      success: false,
      error: { issues: [{ message: "Authentication session must expire after issue." }] },
    });
    expect(() =>
      EnrollStudentResponseSchema.parse({
        kind: "student-invitation-enrolled",
        protocolVersion: "0.1",
        requestId: "request-enroll-1",
        principal: { role: "student", displayName: "Ana" },
        session: {
          ...session,
          issuedAt: "2026-09-03T10:00:00Z",
          expiresAt: "2026-09-03T10:00:00.001Z",
        },
      }),
    ).not.toThrow();
  });

  it("describes the dashboard teacher session without exposing its token", () => {
    const envelope = { protocolVersion: "0.1", requestId: "request-dashboard-1" } as const;
    expect(
      DashboardSessionQuerySchema.parse({ ...envelope, kind: "dashboard-session-query" }),
    ).toEqual({ ...envelope, kind: "dashboard-session-query" });
    const response = DashboardSessionResponseSchema.parse({
      ...envelope,
      kind: "dashboard-session",
      principal: { role: "teacher", displayName: "Ada" },
    });
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.principal)).toBe(true);
    for (const invalid of [
      { ...envelope, kind: "dashboard-session-query", extra: true },
      { ...envelope, kind: "dashboard-session" },
    ])
      expect(DashboardSessionQuerySchema.safeParse(invalid).success).toBe(false);
    for (const invalid of [
      { ...envelope, kind: "dashboard-session", principal: { role: "student", displayName: "S" } },
      {
        ...envelope,
        kind: "dashboard-session",
        principal: { role: "teacher", displayName: "Ada", token: session.token },
      },
      {
        ...envelope,
        kind: "dashboard-session",
        principal: { role: "teacher", displayName: "Ada" },
        session,
      },
      {
        ...envelope,
        kind: "credential-authenticated",
        principal: { role: "teacher", displayName: "Ada" },
      },
    ])
      expect(DashboardSessionResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
