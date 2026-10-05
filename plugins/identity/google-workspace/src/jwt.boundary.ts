import { webcrypto } from "node:crypto";

import { IdentityProviderError } from "@marea/plugin-api";
import * as z from "zod";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const encoder = new TextEncoder();
const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface DecodedJwt {
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signed: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
}

export function base64urlText(text: string): string {
  return Buffer.from(text).toString("base64url");
}

export function base64urlBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function json(segment: string): Readonly<Record<string, unknown>> {
  return JsonObjectSchema.parse(JSON.parse(Buffer.from(segment, "base64url").toString("utf8")));
}

/** Splits a compact JWS without trusting any part of it yet. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = /^(?<header>[\w-]+)\.(?<payload>[\w-]+)\.(?<signature>[\w-]+)$/u.exec(
    token,
  )?.groups;
  if (parts === undefined)
    throw new IdentityProviderError("invalid-response", "The identity token is not compact.");
  try {
    const header = String(parts.header);
    const payload = String(parts.payload);
    return {
      header: json(header),
      payload: json(payload),
      signed: new Uint8Array(encoder.encode(`${header}.${payload}`)),
      signature: bytes(String(parts.signature)),
    };
  } catch {
    throw new IdentityProviderError("invalid-response", "The identity token is malformed.");
  }
}

export type PublicJwk = webcrypto.JsonWebKey & { readonly kid?: string };

export async function verifyRs256(jwt: DecodedJwt, key: PublicJwk): Promise<boolean> {
  // Stryker disable next-line BooleanLiteral: the imported key is never exported, so extractability is unobservable.
  const imported = await webcrypto.subtle.importKey("jwk", key, RS256, false, ["verify"]);
  return webcrypto.subtle.verify(RS256.name, imported, jwt.signature, jwt.signed);
}

/** Signs claims with a PKCS #8 PEM private key, as a Google service account assertion. */
export async function signRs256(claims: object, pkcs8Pem: string): Promise<string> {
  const der = Buffer.from(
    pkcs8Pem.replaceAll(/-----(?:BEGIN|END) PRIVATE KEY-----|\s/gu, ""),
    "base64",
  );
  // Stryker disable next-line BooleanLiteral: the imported key is never exported, so extractability is unobservable.
  const key = await webcrypto.subtle.importKey("pkcs8", new Uint8Array(der), RS256, false, [
    "sign",
  ]);
  const input = `${base64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64urlText(JSON.stringify(claims))}`;
  const signature = await webcrypto.subtle.sign(RS256.name, key, encoder.encode(input));
  return `${input}.${base64urlBytes(new Uint8Array(signature))}`;
}
