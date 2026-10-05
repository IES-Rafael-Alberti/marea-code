import type {
  AdmissionRule,
  ExternalIdentity,
  IdentityProvider,
  IdentityProviderRuntime,
} from "@marea/plugin-api";

import { GoogleGroups } from "./google-groups.js";
import {
  GoogleSigningKeys,
  exchangeGoogleCode,
  googleAuthorizationUrl,
  verifyGoogleIdToken,
} from "./google-oidc.js";
import { parseGoogleWorkspaceSettings } from "./settings.js";

const ADDRESS = /^[a-z0-9._%+-]+@([a-z0-9.-]+)$/u;

export function createGoogleWorkspaceProvider(
  values: Readonly<Record<string, string>>,
  runtime: IdentityProviderRuntime,
): IdentityProvider {
  const settings = parseGoogleWorkspaceSettings(values);
  const keys = new GoogleSigningKeys(runtime);
  const groups =
    settings.groups === undefined ? undefined : new GoogleGroups(settings.groups, runtime);
  const provider: IdentityProvider = {
    authorizationUrl: (request) => googleAuthorizationUrl(settings, request),
    async complete(response) {
      const token = await exchangeGoogleCode(settings, runtime, response);
      return verifyGoogleIdToken(settings, keys, runtime, token, response.nonce, response.signal);
    },
    /** Addresses and groups of the school's own domain; groups only with group admission set up. */
    normalizeRule(kind: string, value: string) {
      const address = value.trim().toLowerCase();
      const domain = ADDRESS.exec(address)?.[1];
      const supported = kind === "email" || (kind === "group" && groups !== undefined);
      return supported && domain === settings.domain ? address : undefined;
    },
    async admits(identity: ExternalIdentity, rules: readonly AdmissionRule[], signal: AbortSignal) {
      if (rules.some((rule) => rule.kind === "email" && rule.value === identity.email)) return true;
      for (const rule of rules)
        if (rule.kind === "group" && (await groups?.hasMember(rule.value, identity.email, signal)))
          return true;
      return false;
    },
  };
  return Object.freeze(provider);
}
