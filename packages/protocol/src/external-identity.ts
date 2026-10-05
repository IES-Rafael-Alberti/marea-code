import * as z from "zod";

import { AuthSessionSchema, SafeStudentPrincipalSchema } from "./auth.js";
import { RequestIdSchema } from "./identifiers.js";
import { UtcTimestampSchema } from "./runs.js";
import { RevisionIdSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const EXTERNAL_ACCESS_PATH = "/api/v1/dashboard/external-access";
export const MAX_EXTERNAL_PROVIDERS = 8;
export const MAX_EXTERNAL_RULES_PER_CLASS = 500;
export const MAX_EXTERNAL_RULE_VALUES_PER_CHANGE = 200;

const envelope = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
};

/** A plugin identifier such as `org.marea.google-workspace`. */
export const IdentityProviderIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u);

export const LocalizedLabelSchema = z
  .object({
    es: z.string().min(1).max(120),
    en: z.string().min(1).max(120),
    eu: z.string().min(1).max(120),
  })
  .strict()
  .readonly();

/** RFC 8252 loopback redirection to the student's own machine; never a remote host. */
export const LoopbackRedirectUriSchema = z.string().refine((value) => {
  // A non-matching value has no port, and NaN fails both bounds.
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d{4,5})\/callback$/u.exec(value)?.[1]);
  return port >= 1_024 && port <= 65_535;
}, "Use an unprivileged loopback callback.");

const FlowIdSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const ExternalAuthProvidersRequestSchema = z
  .object({ kind: z.literal("external-auth-providers-query"), ...envelope })
  .strict()
  .readonly();

export const ExternalAuthProviderSchema = z
  .object({ providerId: IdentityProviderIdSchema, displayName: LocalizedLabelSchema })
  .strict()
  .readonly();

export const ExternalAuthProvidersResponseSchema = z
  .object({
    kind: z.literal("external-auth-providers"),
    ...envelope,
    providers: z.array(ExternalAuthProviderSchema).max(MAX_EXTERNAL_PROVIDERS).readonly(),
  })
  .strict()
  .readonly();

export const ExternalAuthBeginRequestSchema = z
  .object({
    kind: z.literal("external-auth-begin"),
    ...envelope,
    providerId: IdentityProviderIdSchema,
    redirectUri: LoopbackRedirectUriSchema,
  })
  .strict()
  .readonly();

export const ExternalAuthBeginResponseSchema = z
  .object({
    kind: z.literal("external-auth-started"),
    ...envelope,
    flowId: FlowIdSchema,
    authorizationUrl: z.url({ protocol: /^https$/u }).max(4_096),
    expiresAt: UtcTimestampSchema,
  })
  .strict()
  .readonly();

export const ExternalAuthCompleteRequestSchema = z
  .object({
    kind: z.literal("external-auth-complete"),
    ...envelope,
    flowId: FlowIdSchema,
    state: FlowIdSchema,
    code: z
      .string()
      .min(1)
      .max(2_048)
      .regex(/^[\x21-\x7e]+$/u),
  })
  .strict()
  .readonly();

export const ExternalAuthCompleteResponseSchema = z
  .object({
    kind: z.literal("external-authenticated"),
    ...envelope,
    principal: SafeStudentPrincipalSchema,
    session: AuthSessionSchema,
  })
  .strict()
  .readonly();

export const ExternalRuleKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);
export const ExternalRuleValueSchema = z
  .string()
  .min(1)
  .max(320)
  .regex(/^[\x21-\x7e]+$/u);

export const ExternalAccessRuleSchema = z
  .object({
    providerId: IdentityProviderIdSchema,
    kind: ExternalRuleKindSchema,
    value: ExternalRuleValueSchema,
  })
  .strict()
  .readonly();

export const ExternalAccessProviderSchema = z
  .object({
    providerId: IdentityProviderIdSchema,
    displayName: LocalizedLabelSchema,
    ruleKinds: z
      .array(
        z.object({ kind: ExternalRuleKindSchema, label: LocalizedLabelSchema }).strict().readonly(),
      )
      .min(1)
      .max(8)
      .readonly(),
  })
  .strict()
  .readonly();

export const ExternalAccessQuerySchema = z
  .object({ kind: z.literal("external-access-query"), ...envelope, classId: RevisionIdSchema })
  .strict()
  .readonly();

export const ExternalAccessChangeSchema = z
  .object({
    kind: z.literal("external-access-change"),
    ...envelope,
    classId: RevisionIdSchema,
    operation: z.enum(["add", "remove"]),
    providerId: IdentityProviderIdSchema,
    ruleKind: ExternalRuleKindSchema,
    values: z.array(z.string().max(320)).min(1).max(MAX_EXTERNAL_RULE_VALUES_PER_CHANGE).readonly(),
  })
  .strict()
  .readonly();

export const ExternalAccessRequestSchema = z.discriminatedUnion("kind", [
  ExternalAccessQuerySchema,
  ExternalAccessChangeSchema,
]);

export const ExternalAccessResponseSchema = z
  .object({
    kind: z.literal("external-access"),
    ...envelope,
    classId: RevisionIdSchema,
    providers: z.array(ExternalAccessProviderSchema).max(MAX_EXTERNAL_PROVIDERS).readonly(),
    rules: z.array(ExternalAccessRuleSchema).max(MAX_EXTERNAL_RULES_PER_CLASS).readonly(),
    rejected: z.array(z.string().max(320)).max(MAX_EXTERNAL_RULE_VALUES_PER_CHANGE).readonly(),
  })
  .strict()
  .readonly();

export type IdentityProviderId = z.infer<typeof IdentityProviderIdSchema>;
export type LocalizedLabel = z.infer<typeof LocalizedLabelSchema>;
export type ExternalAuthProvider = z.infer<typeof ExternalAuthProviderSchema>;
export type ExternalAuthProvidersRequest = z.infer<typeof ExternalAuthProvidersRequestSchema>;
export type ExternalAuthProvidersResponse = z.infer<typeof ExternalAuthProvidersResponseSchema>;
export type ExternalAuthBeginRequest = z.infer<typeof ExternalAuthBeginRequestSchema>;
export type ExternalAuthBeginResponse = z.infer<typeof ExternalAuthBeginResponseSchema>;
export type ExternalAuthCompleteRequest = z.infer<typeof ExternalAuthCompleteRequestSchema>;
export type ExternalAuthCompleteResponse = z.infer<typeof ExternalAuthCompleteResponseSchema>;
export type ExternalAccessRule = z.infer<typeof ExternalAccessRuleSchema>;
export type ExternalAccessProvider = z.infer<typeof ExternalAccessProviderSchema>;
export type ExternalAccessRequest = z.infer<typeof ExternalAccessRequestSchema>;
export type ExternalAccessResponse = z.infer<typeof ExternalAccessResponseSchema>;
