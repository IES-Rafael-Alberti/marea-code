import { randomUUID } from "node:crypto";
import { RevisionIdSchema } from "@marea/protocol";
import type { GovernanceIdGenerator } from "./authority.js";

export const governanceCryptoIds: GovernanceIdGenerator = Object.freeze({
  createId: (kind: Parameters<GovernanceIdGenerator["createId"]>[0]) =>
    RevisionIdSchema.parse(`${kind}:${randomUUID()}`),
});
