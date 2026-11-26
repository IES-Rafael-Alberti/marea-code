import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  PrivateFilesystemError,
  privateFilesystemError,
  type WindowsPrivateFailureReason,
} from "./private-filesystem-error.js";
import { WINDOWS_ACL_SCRIPT } from "./windows-acl-script.js";
import { windowsPowerShell } from "./windows-powershell.js";

/** Delay before the single retry of a transient ACL failure (antivirus locks). */
const RETRY_DELAY_MS = 250;

/** Reasons the PowerShell script may print; every other output is unexpected. */
const SCRIPT_FAILURE_REASONS = new Set<string>([
  "unsupported-volume",
  "reparse-point",
  "owner-mismatch",
  "foreign-ace",
  "missing-user-access",
  "set-acl-failed",
  "unexpected",
]);

/** Only these transient failures are retried once; owner/ACE/volume/reparse never are. */
const TRANSIENT_REASONS = new Set<WindowsPrivateFailureReason>([
  "spawn-failed",
  "timeout",
  "set-acl-failed",
]);

function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

function resultKind(result: SpawnSyncReturns<string>): "directory" | "file" | undefined {
  if (result.status !== 0 || result.error !== undefined) return undefined;
  const stdout = result.stdout;
  return stdout === "file" || stdout === "directory" ? stdout : undefined;
}

function failureReason(result: SpawnSyncReturns<string>): WindowsPrivateFailureReason {
  if (result.error !== undefined || result.signal !== null) {
    const code =
      result.error === undefined ? undefined : (result.error as NodeJS.ErrnoException).code;
    return code === "ETIMEDOUT" || result.signal !== null ? "timeout" : "spawn-failed";
  }
  if (result.status !== 0) {
    const stdout = result.stdout;
    return SCRIPT_FAILURE_REASONS.has(stdout)
      ? (stdout as WindowsPrivateFailureReason)
      : "non-zero-exit";
  }
  return "unexpected-output";
}

function runAclCheck(path: string, action: "inspect" | "secure"): SpawnSyncReturns<string> {
  const powershell = windowsPowerShell(WINDOWS_ACL_SCRIPT);
  return spawnSync(powershell.file, powershell.args, {
    input: Buffer.from(JSON.stringify({ path, action })).toString("base64"),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024,
    windowsHide: true,
  });
}

/**
 * Runs the Windows ACL check, retrying once for transient failures only.
 * Throws `PrivateFilesystemError` with a `private-fs.<reason>` diagnostic code
 * when the path is not a protected local path.
 */
export function checkWindowsPrivatePath(
  path: string,
  action: "inspect" | "secure",
): "directory" | "file" {
  // Only local absolute DOS paths: no UNC, device aliases, ADS or NULs.
  if (!/^[a-zA-Z]:[\\/][^:\0]*$/.test(path)) {
    // UNC shares (redirected or roaming profiles) are network storage, not a local volume.
    throw privateFilesystemError(
      /^[\\/]{2}[^\\/]/.test(path) ? "unsupported-volume" : "unexpected",
    );
  }
  let result = runAclCheck(path, action);
  let kind = resultKind(result);
  if (kind !== undefined) return kind;
  let reason = failureReason(result);
  if (TRANSIENT_REASONS.has(reason)) {
    sleepSync(RETRY_DELAY_MS);
    result = runAclCheck(path, action);
    kind = resultKind(result);
    if (kind !== undefined) return kind;
    reason = failureReason(result);
  }
  throw privateFilesystemError(reason);
}

/**
 * Non-throwing inspection adapter. Callers that treat "not private" as a value
 * (rather than an error) use this; it returns undefined on every ACL failure.
 */
export function windowsPrivateKind(
  path: string,
  action: "inspect" | "secure",
): "directory" | "file" | undefined {
  try {
    return checkWindowsPrivatePath(path, action);
  } catch (error) {
    if (error instanceof PrivateFilesystemError) return undefined;
    throw error;
  }
}
