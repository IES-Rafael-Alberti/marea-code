import {
  IdentityProviderError,
  type ExternalIdentity,
  type IdentityAuthorizationRequest,
  type IdentityAuthorizationResponse,
  type IdentityProviderRuntime,
} from "@marea/plugin-api";
import * as z from "zod";

import { googleJson, googleRequest } from "./google-http.boundary.js";
import { decodeJwt, verifyRs256, type PublicJwk } from "./jwt.boundary.js";
import type { GoogleWorkspaceSettings } from "./settings.js";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_CERTIFICATES_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_KEYS_SECONDS = 3_600;

const TokenResponseSchema = z.object({ id_token: z.string().min(1).max(8_192) });
const KeysSchema = z.object({
  keys: z
    .array(z.object({ kid: z.string().min(1), kty: z.literal("RSA") }).loose())
    .min(1)
    .max(16),
});
const ClaimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1).max(255),
  email: z.string().min(3).max(320),
  email_verified: z.literal(true),
  hd: z.string(),
  nonce: z.string(),
  exp: z.number(),
  iat: z.number(),
  name: z.string().max(240).optional(),
});

function failure(code: "denied" | "invalid-response" | "unavailable", message: string): never {
  throw new IdentityProviderError(code, message);
}

export function googleAuthorizationUrl(
  settings: GoogleWorkspaceSettings,
  request: IdentityAuthorizationRequest,
): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: request.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    hd: settings.domain,
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/** Google's signing keys, reused for as long as Google allows them to be cached. */
export class GoogleSigningKeys {
  #cache: { readonly keys: readonly PublicJwk[]; readonly until: number } | undefined;

  constructor(private readonly runtime: IdentityProviderRuntime) {}

  async key(kid: string, signal: AbortSignal): Promise<PublicJwk> {
    const cached =
      this.#cache !== undefined && this.#cache.until > this.runtime.now()
        ? this.#cache.keys.find((key) => key.kid === kid)
        : undefined;
    if (cached !== undefined) return cached;
    const response = await googleRequest(
      this.runtime,
      new Request(GOOGLE_CERTIFICATES_ENDPOINT, { signal }),
    );
    const parsed = KeysSchema.safeParse(await googleJson(response));
    if (!response.ok || !parsed.success) failure("invalid-response", "Google keys are unusable.");
    const maxAge = Number(
      /max-age=(\d+)/u.exec(String(response.headers.get("cache-control")))?.[1],
    );
    const keys = parsed.data.keys as readonly PublicJwk[];
    this.#cache = {
      keys,
      until:
        this.runtime.now() + (Number.isSafeInteger(maxAge) ? maxAge : DEFAULT_KEYS_SECONDS) * 1_000,
    };
    return (
      keys.find((key) => key.kid === kid) ??
      failure("invalid-response", "Google did not publish the token key.")
    );
  }
}

export async function exchangeGoogleCode(
  settings: GoogleWorkspaceSettings,
  runtime: IdentityProviderRuntime,
  response: IdentityAuthorizationResponse,
): Promise<string> {
  const answer = await googleRequest(
    runtime,
    new Request(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: response.code,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: response.redirectUri,
        grant_type: "authorization_code",
        code_verifier: response.codeVerifier,
      }).toString(),
      signal: response.signal,
    }),
  );
  if (!answer.ok) {
    await answer.body?.cancel();
    return failure("denied", "Google refused the authorization code.");
  }
  const parsed = TokenResponseSchema.safeParse(await googleJson(answer));
  return parsed.success
    ? parsed.data.id_token
    : failure("invalid-response", "Google returned no identity token.");
}

/** Accepts only a fresh, signed, verified address of the school's own Workspace domain. */
export async function verifyGoogleIdToken(
  settings: GoogleWorkspaceSettings,
  keys: GoogleSigningKeys,
  runtime: IdentityProviderRuntime,
  token: string,
  nonce: string,
  signal: AbortSignal,
): Promise<ExternalIdentity> {
  const jwt = decodeJwt(token);
  if (jwt.header.alg !== "RS256" || typeof jwt.header.kid !== "string")
    failure("invalid-response", "The identity token is not signed with a Google key.");
  if (!(await verifyRs256(jwt, await keys.key(jwt.header.kid, signal))))
    failure("invalid-response", "The identity token signature is invalid.");
  const parsed = ClaimsSchema.safeParse(jwt.payload);
  if (!parsed.success) return failure("denied", "The identity token lacks a verified address.");
  const claims = parsed.data;
  const now = runtime.now() / 1_000;
  const email = claims.email.toLowerCase();
  if (
    !ISSUERS.includes(claims.iss) ||
    claims.aud !== settings.clientId ||
    claims.nonce !== nonce ||
    claims.exp + CLOCK_SKEW_SECONDS <= now ||
    claims.iat - CLOCK_SKEW_SECONDS > now ||
    claims.hd !== settings.domain ||
    !email.endsWith(`@${settings.domain}`)
  )
    failure("denied", "The identity token is not valid for this school.");
  return { subject: claims.sub, email, displayName: claims.name ?? "" };
}
