import * as z from "zod";

import { InvitationCodeSchema, RequestIdSchema, SessionTokenSchema } from "./identifiers.js";
import { UtcTimestampSchema } from "./runs.js";
import { SafeDisplayNameSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const PrincipalRoleSchema = z.enum(["student", "teacher"]);

export const SafePrincipalSchema = z
  .object({
    role: PrincipalRoleSchema,
    displayName: SafeDisplayNameSchema,
  })
  .strict()
  .readonly();

export const SafeStudentPrincipalSchema = z
  .object({
    role: z.literal("student"),
    displayName: SafeDisplayNameSchema,
  })
  .strict()
  .readonly();

export const CredentialLoginSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const CredentialPasswordSchema = z.string().min(12).max(256);

const CredentialsSchema = z
  .object({
    login: CredentialLoginSchema,
    password: CredentialPasswordSchema,
  })
  .strict()
  .readonly();

export const EnrollStudentRequestSchema = z
  .object({
    kind: z.literal("student-invitation-enrollment"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    invitationCode: InvitationCodeSchema,
    displayName: SafeDisplayNameSchema,
    credentials: CredentialsSchema,
  })
  .strict()
  .readonly();

const AuthSessionSchema = z
  .object({
    token: SessionTokenSchema,
    issuedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
  })
  .strict()
  .refine(
    (session) => Date.parse(session.expiresAt) > Date.parse(session.issuedAt),
    "Authentication session must expire after issue.",
  )
  .readonly();

export const EnrollStudentResponseSchema = z
  .object({
    kind: z.literal("student-invitation-enrolled"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    principal: SafeStudentPrincipalSchema,
    session: AuthSessionSchema,
  })
  .strict()
  .readonly();

export const CredentialLoginRequestSchema = z
  .object({
    kind: z.literal("credential-login"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    credentials: CredentialsSchema,
  })
  .strict()
  .readonly();

export const CredentialLoginResponseSchema = z
  .object({
    kind: z.literal("credential-authenticated"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    principal: SafePrincipalSchema,
    session: AuthSessionSchema,
  })
  .strict()
  .readonly();

export const CredentialLogoutRequestSchema = z
  .object({
    kind: z.literal("credential-logout"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
  })
  .strict()
  .readonly();

export const CredentialLogoutResponseSchema = z
  .object({
    kind: z.literal("credential-logged-out"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    loggedOutAt: UtcTimestampSchema,
    alreadyLoggedOut: z.boolean(),
  })
  .strict()
  .readonly();

/** The signed-in dashboard teacher; the session token stays in an HttpOnly cookie. */
export const DashboardSessionResponseSchema = z
  .object({
    kind: z.literal("dashboard-session"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    principal: z
      .object({ role: z.literal("teacher"), displayName: SafeDisplayNameSchema })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const DashboardSessionQuerySchema = z
  .object({
    kind: z.literal("dashboard-session-query"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
  })
  .strict()
  .readonly();

export type CredentialLoginRequest = z.infer<typeof CredentialLoginRequestSchema>;
export type DashboardSessionQuery = z.infer<typeof DashboardSessionQuerySchema>;
export type DashboardSessionResponse = z.infer<typeof DashboardSessionResponseSchema>;
export type CredentialLoginResponse = z.infer<typeof CredentialLoginResponseSchema>;
export type CredentialLogoutRequest = z.infer<typeof CredentialLogoutRequestSchema>;
export type CredentialLogoutResponse = z.infer<typeof CredentialLogoutResponseSchema>;
export type EnrollStudentRequest = z.infer<typeof EnrollStudentRequestSchema>;
export type EnrollStudentResponse = z.infer<typeof EnrollStudentResponseSchema>;
export type PrincipalRole = z.infer<typeof PrincipalRoleSchema>;
export type SafePrincipal = z.infer<typeof SafePrincipalSchema>;
export type SafeStudentPrincipal = z.infer<typeof SafeStudentPrincipalSchema>;
