import { createHash } from "node:crypto";
import { ClassExchangeSchema, Sha256DigestSchema, type ClassExchange } from "@marea/protocol";

export function classExchangeDigest(value: ClassExchange) {
  return Sha256DigestSchema.parse(
    `sha256:${createHash("sha256")
      .update(JSON.stringify(ClassExchangeSchema.parse(value)))
      .digest("hex")}`,
  );
}
