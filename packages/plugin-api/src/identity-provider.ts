import * as z from "zod";

import {
  createCommonManifestShape,
  hasSafeRelationships,
  safeRelationshipMessage,
} from "./manifest-fields.js";
import {
  ProviderSettingsDescriptorSchema,
  type ProviderSettingsDescriptor,
} from "./provider-settings.js";

const unique = (values: readonly string[]) => new Set(values).size === values.length;

export function createIdentityProviderManifestSchema() {
  return z
    .object({
      ...createCommonManifestShape(),
      kind: z.literal("identity-provider"),
      apiVersion: z.literal("1.0"),
      capabilities: z
        .array(z.enum(["authorization-code", "group-admission"]))
        .min(1)
        .refine(unique, "Capabilities must be unique.")
        .readonly(),
      runtimeTargets: z.tuple([z.literal("teacher-server")]).readonly(),
      dataClassifications: z
        .array(z.enum(["student-identifier"]))
        .min(1)
        .refine(unique, "Data classifications must be unique.")
        .readonly(),
    })
    .strict()
    .refine(hasSafeRelationships, safeRelationshipMessage())
    .readonly();
}

export type IdentityProviderManifest = z.infer<
  ReturnType<typeof createIdentityProviderManifestSchema>
>;

const labelText = z.string().min(1).max(120);
const IdentityLabelSchema = z
  .object({ es: labelText, en: labelText, eu: labelText })
  .strict()
  .readonly();

/** What students and teachers see of a provider; it never contains settings or secrets. */
export const IdentityProviderDescriptorSchema = z
  .object({
    displayName: IdentityLabelSchema,
    ruleKinds: z
      .array(
        z
          .object({ kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u), label: IdentityLabelSchema })
          .strict()
          .readonly(),
      )
      .min(1)
      .max(8)
      .refine(
        (kinds) => unique(kinds.map((entry) => entry.kind)),
        "Admission rule kinds must be unique.",
      )
      .readonly(),
  })
  .strict()
  .readonly();

export type IdentityProviderDescriptor = z.infer<typeof IdentityProviderDescriptorSchema>;

/** A verified person as the provider asserts it: a stable subject, never a display claim. */
export interface ExternalIdentity {
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
}

export interface AdmissionRule {
  readonly kind: string;
  readonly value: string;
}

export interface IdentityAuthorizationRequest {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export interface IdentityAuthorizationResponse {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly signal: AbortSignal;
}

export interface IdentityProvider {
  /** The provider page that asks the person to sign in, bound to this state and challenge. */
  authorizationUrl(request: IdentityAuthorizationRequest): string;
  /** Exchanges the code and verifies the answer; it rejects anything it cannot verify. */
  complete(response: IdentityAuthorizationResponse): Promise<ExternalIdentity>;
  /** The canonical form of a teacher's rule value, or undefined when it is not valid. */
  normalizeRule(kind: string, value: string): string | undefined;
  /** Whether any of a class's rules admits this verified person. */
  admits(
    identity: ExternalIdentity,
    rules: readonly AdmissionRule[],
    signal: AbortSignal,
  ): Promise<boolean>;
}

export interface IdentityProviderRuntime {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly now: () => number;
}

export type IdentityProviderFactory = (
  settings: Readonly<Record<string, string>>,
  runtime: IdentityProviderRuntime,
) => IdentityProvider;

export interface IdentityProviderCatalogEntry {
  readonly manifest: IdentityProviderManifest;
  readonly descriptor: IdentityProviderDescriptor;
  readonly settings: ProviderSettingsDescriptor;
  readonly create: IdentityProviderFactory;
}

export function defineIdentityProviderCatalogEntry(
  entry: IdentityProviderCatalogEntry,
): IdentityProviderCatalogEntry {
  return entry;
}

/** Validates the plugin-authored parts of an entry before the host trusts them. */
export function parseIdentityProviderEntry(
  entry: IdentityProviderCatalogEntry,
): IdentityProviderCatalogEntry {
  return {
    ...entry,
    descriptor: IdentityProviderDescriptorSchema.parse(entry.descriptor),
    settings: ProviderSettingsDescriptorSchema.parse(entry.settings),
  };
}

export type IdentityProviderErrorCode = "denied" | "invalid-response" | "unavailable";

/** A provider failure; hosts show students one sanitized message whatever its cause. */
export class IdentityProviderError extends Error {
  public readonly code: IdentityProviderErrorCode;

  public constructor(code: IdentityProviderErrorCode, message: string) {
    super(message);
    this.name = "IdentityProviderError";
    this.code = code;
  }
}
