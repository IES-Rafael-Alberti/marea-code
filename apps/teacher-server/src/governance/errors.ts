export class GovernanceResourceError extends Error {
  constructor() {
    super("Governance resource limit exceeded.");
    this.name = "GovernanceResourceError";
  }
}
