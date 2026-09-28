import { createHmac, randomBytes, randomUUID } from "node:crypto";

import type { Clock, IdGenerator, SecretDigest, SecretIssuer } from "./contracts.js";

export const systemClock: Clock = Object.freeze({
  now(): string {
    return new Date().toISOString();
  },
});

export const cryptoIdGenerator: IdGenerator = Object.freeze({
  createId(namespace: Parameters<IdGenerator["createId"]>[0]): string {
    return `${namespace}:${randomUUID()}`;
  },
});

export const cryptoSecretIssuer: SecretIssuer = Object.freeze({
  issue(): string {
    return randomBytes(32).toString("base64url");
  },
});

export function createHmacSecretDigest(pepper: Uint8Array): SecretDigest {
  if (pepper.byteLength < 32) {
    throw new Error("The credential digest pepper must contain at least 32 bytes.");
  }
  const ownedPepper = Uint8Array.from(pepper);
  return Object.freeze({
    digest(secret: string): string {
      return createHmac("sha256", ownedPepper).update(secret).digest("hex");
    },
  });
}
