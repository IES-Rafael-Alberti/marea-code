const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * Failure reasons the Windows ACL boundary can distinguish. The PowerShell
 * script reports the volume/reparse/ACE reasons; the boundary reports the
 * spawn/timeout/output reasons.
 */
export type WindowsPrivateFailureReason =
  | "spawn-failed"
  | "timeout"
  | "non-zero-exit"
  | "unexpected-output"
  | "unsupported-volume"
  | "reparse-point"
  | "owner-mismatch"
  | "foreign-ace"
  | "missing-user-access"
  | "set-acl-failed"
  | "unexpected";

/**
 * A private-state permission failure safe to surface as a diagnostic code.
 *
 * `diagnosticCode` follows the shared diagnostic contract (lowercase letters,
 * digits, dots and hyphens only) and never carries paths, tokens or user
 * content. The message stays the human-facing description chosen by the caller.
 */
export class PrivateFilesystemError extends Error {
  constructor(
    readonly diagnosticCode: string,
    message?: string,
  ) {
    if (!DIAGNOSTIC_CODE_PATTERN.test(diagnosticCode)) {
      throw new Error("Invalid private filesystem diagnostic code.");
    }
    super(message ?? "Private filesystem permissions could not be established.");
    this.name = "PrivateFilesystemError";
  }
}

export function privateFilesystemError(
  reason: WindowsPrivateFailureReason,
  message?: string,
): PrivateFilesystemError {
  return new PrivateFilesystemError(`private-fs.${reason}`, message);
}
