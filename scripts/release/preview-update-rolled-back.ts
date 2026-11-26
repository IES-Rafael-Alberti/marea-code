/** The update failed after its journal was written, and the previous release is selected again. */
export class UpdateRolledBackError extends Error {
  public constructor(failure: string) {
    super(failure);
    this.name = "UpdateRolledBackError";
  }
}
