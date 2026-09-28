import type { IdentityCreationGuard } from "../../persistence/identity-creation-guard.js";
import { TargetRefSchema } from "../schemas.js";
import type { CreationGate } from "../storage/sqlite-deletion-index.js";

/** Account identities are stable keys; the observation is irrelevant to the tombstone check. */
export function createAccountCreationGuard(gate: CreationGate): IdentityCreationGuard {
  return Object.freeze({
    accountCreatable: (userId: string) =>
      gate.check(
        TargetRefSchema.parse({
          kind: "account",
          key: { userId },
          observed: { kind: "version", version: "creation-probe" },
        }),
      ).allowed,
  });
}
