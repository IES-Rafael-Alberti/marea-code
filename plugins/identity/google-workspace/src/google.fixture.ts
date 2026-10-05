import { webcrypto } from "node:crypto";

import type { IdentityProviderRuntime } from "@marea/plugin-api";

import { base64urlBytes, base64urlText } from "./jwt.boundary.js";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export const NOW_MS = Date.parse("2026-10-05T10:00:00.000Z");
export const CLIENT_ID = "client.apps.googleusercontent.com";
export const DOMAIN = "school.test";

export async function rsaKeys(kid = "key-1") {
  const pair = await webcrypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const publicJwk = { ...(await webcrypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
    "base64",
  );
  return {
    kid,
    publicJwk,
    privateKey: pair.privateKey,
    pem: `-----BEGIN PRIVATE KEY-----\n${pkcs8.replaceAll(/(.{64})/gu, "$1\n")}\n-----END PRIVATE KEY-----\n`,
  };
}

export type RsaKeys = Awaited<ReturnType<typeof rsaKeys>>;

export async function signedToken(
  keys: RsaKeys,
  payload: object,
  header: object = { alg: "RS256", kid: keys.kid, typ: "JWT" },
): Promise<string> {
  const input = `${base64urlText(JSON.stringify(header))}.${base64urlText(JSON.stringify(payload))}`;
  const signature = await webcrypto.subtle.sign(
    RS256.name,
    keys.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64urlBytes(new Uint8Array(signature))}`;
}

export function claims(overrides: object = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "1234567890",
    email: "Ana@School.test",
    email_verified: true,
    hd: DOMAIN,
    nonce: "nonce-1",
    exp: NOW_MS / 1_000 + 3_600,
    iat: NOW_MS / 1_000,
    name: "Ana García",
    ...overrides,
  };
}

export type Route = (request: Request) => Response | Promise<Response>;

/** A Google stand-in that records every request and answers through per-URL routes. */
export function fakeGoogle(routes: Readonly<Record<string, Route>>) {
  const seen: Request[] = [];
  const clock = { now: NOW_MS };
  const runtime: IdentityProviderRuntime = {
    fetch: async (request) => {
      seen.push(request);
      const url = new URL(request.url);
      const route = routes[`${url.origin}${url.pathname}`];
      if (route === undefined) throw new TypeError(`Unexpected request ${request.url}`);
      return route(request);
    },
    now: () => clock.now,
  };
  return { runtime, seen, clock };
}

export function json(value: object, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
