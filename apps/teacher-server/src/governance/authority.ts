import type { Center, RequestId, Revocation } from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";

export type Id = Center["centerId"];
export type Version = Center["version"];
export type Time = Revocation["revokedAt"];

/** Resolved from a live cookie session row, never from a browser actor field. */
export interface GovernanceSession {
  readonly identity: AuthenticatedIdentity;
  readonly sessionId: Id;
  readonly expiresAt: Time;
}

/** Private cookie composition hashes the token with the existing SecretDigest. */
export interface GovernanceSessionResolver {
  resolve(tokenHash: string, now: Time): GovernanceSession | undefined;
}
export interface GovernanceIdGenerator {
  createId(kind: "revision" | "preview"): Id;
}

/** Created by private installation composition after taking its exclusive lock.
 * assertOwned must synchronously throw after release/loss of that same lock.
 * The function makes this capability non-JSON; it is not a network credential.
 */
export interface InstallationCapability {
  readonly kind: "exclusive-installation-owner";
  readonly installationRoot: string;
  readonly assertOwned: () => undefined;
}
export type GovernanceAuthority =
  | { readonly kind: "administrator"; readonly session: GovernanceSession }
  | { readonly kind: "operator"; readonly installation: InstallationCapability };

/** All reads and commits recheck the live authority; no cached grant arrays. */
export interface GovernanceReadContext {
  readonly authority: GovernanceAuthority;
  readonly now: Time;
}
export interface GovernanceCommitContext extends GovernanceReadContext {
  readonly requestId: RequestId;
  readonly generatedVersion: Version;
}
export interface OperatorContext {
  readonly authority: InstallationCapability;
  readonly now: Time;
  readonly requestId: RequestId;
}
