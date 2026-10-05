import { IdentityProviderError, type IdentityProviderRuntime } from "@marea/plugin-api";
import * as z from "zod";

import { googleJson, googleRequest } from "./google-http.boundary.js";
import { GOOGLE_TOKEN_ENDPOINT } from "./google-oidc.js";
import { signRs256 } from "./jwt.boundary.js";
import type { GroupSettings } from "./settings.js";

export const GROUP_MEMBER_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly";
export const DIRECTORY_GROUPS_ENDPOINT = "https://admin.googleapis.com/admin/directory/v1/groups";
const TOKEN_SECONDS = 3_600;
const RENEWAL_MARGIN_MS = 60_000;

const AccessTokenSchema = z.object({
  access_token: z.string().min(1).max(4_096),
  expires_in: z.number().int().positive(),
});
const MembershipSchema = z.object({ isMember: z.boolean() });

/**
 * Reads group membership, including nested groups, as the delegated administrator through a
 * read-only scope. The access token is reused until shortly before it expires.
 */
export class GoogleGroups {
  #token: { readonly value: string; readonly until: number } | undefined;

  constructor(
    private readonly settings: GroupSettings,
    private readonly runtime: IdentityProviderRuntime,
  ) {}

  async hasMember(group: string, email: string, signal: AbortSignal): Promise<boolean> {
    const token = await this.accessToken(signal);
    const response = await googleRequest(
      this.runtime,
      new Request(
        `${DIRECTORY_GROUPS_ENDPOINT}/${encodeURIComponent(group)}/hasMember/${encodeURIComponent(email)}`,
        { headers: { authorization: `Bearer ${token}` }, signal },
      ),
    );
    // An unknown group or a member outside the directory is simply not a member.
    if (response.status === 400 || response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    const parsed = MembershipSchema.safeParse(await googleJson(response));
    if (!response.ok || !parsed.success)
      throw new IdentityProviderError("unavailable", "Google group membership is unavailable.");
    return parsed.data.isMember;
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    const now = this.runtime.now();
    if (this.#token !== undefined && this.#token.until > now) return this.#token.value;
    const issuedAt = Math.floor(now / 1_000);
    const assertion = await signRs256(
      {
        iss: this.settings.serviceAccountEmail,
        sub: this.settings.adminEmail,
        scope: GROUP_MEMBER_SCOPE,
        aud: GOOGLE_TOKEN_ENDPOINT,
        iat: issuedAt,
        exp: issuedAt + TOKEN_SECONDS,
      },
      this.settings.serviceAccountKey,
    );
    const response = await googleRequest(
      this.runtime,
      new Request(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        signal,
      }),
    );
    const parsed = AccessTokenSchema.safeParse(await googleJson(response));
    if (!response.ok || !parsed.success)
      throw new IdentityProviderError("unavailable", "Google refused the service account.");
    this.#token = {
      value: parsed.data.access_token,
      until: now + parsed.data.expires_in * 1_000 - RENEWAL_MARGIN_MS,
    };
    return parsed.data.access_token;
  }
}
