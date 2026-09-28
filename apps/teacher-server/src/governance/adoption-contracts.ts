import type { Sha256Digest } from "@marea/protocol";
import type { Id } from "./authority.js";

export interface AdoptionMap {
  readonly classes: readonly { readonly classId: Id; readonly centerId: Id }[];
  readonly accounts: readonly { readonly userId: Id; readonly ownerCenterId: Id }[];
  readonly administrators: readonly { readonly userId: Id; readonly centerId: Id }[];
}
export interface AdoptionReceipt {
  /** Complete map and relational inventory fingerprint, not an ID or bearer token. */
  readonly digest: Sha256Digest;
  readonly classes: number;
  readonly accounts: number;
  readonly memberships: number;
  readonly missingClassIds: readonly Id[];
  readonly missingUserIds: readonly Id[];
}
