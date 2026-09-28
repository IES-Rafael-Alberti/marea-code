/** Refuses externally chosen identities that permanent deletion has retired. */
export interface IdentityCreationGuard {
  accountCreatable(userId: string): boolean;
}

/**
 * For compositions that do not own a deletion index yet. Permanent deletion must never be
 * enabled for an installation composed with this guard.
 */
export function withoutDeletionAuthority(): IdentityCreationGuard {
  return Object.freeze({ accountCreatable: () => true });
}
