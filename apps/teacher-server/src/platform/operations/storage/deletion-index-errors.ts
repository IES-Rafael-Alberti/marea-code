export class DeletionIndexStorageError extends Error {
  public constructor(
    public readonly code:
      | "missing-authority"
      | "stale-authority"
      | "pending-checkpoint"
      | "tombstoned-identity"
      | "invalid-transition"
      | "index-corrupt",
    message: string,
  ) {
    super(message);
    this.name = "DeletionIndexStorageError";
  }
}
