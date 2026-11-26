import {
  auditWindowsPrivateAccess,
  securePrivatePath,
  type WindowsAccessAudit,
} from "@marea/private-filesystem";

import type { FailureLog } from "./failure-log.boundary.js";

/**
 * The student's private state keeps strict POSIX modes. On Windows it relies on the user
 * profile's inherited permissions, like any other application: the student client never writes
 * an ACL, so a folder Windows refuses to re-protect can never lock the student out.
 */
export function securePrivateDirectory(path: string): void {
  if (process.platform === "win32") return;
  securePrivatePath(path, 0o700);
}

/** Protect a private file on POSIX; on Windows it inherits its folder's permissions. */
export function securePrivateFileParent(path: string): void {
  if (process.platform === "win32") return;
  securePrivatePath(path, 0o600);
}

function permissionRecord(audit: WindowsAccessAudit): Readonly<Record<string, unknown>> | null {
  if (audit.status === "private") return null;
  if (audit.status === "exposed") return { result: "broad-access", principals: audit.principals };
  return { result: "check-failed", code: audit.code };
}

/**
 * Startup check on Windows: if other accounts may read the state folder, or the check itself
 * fails, write a private local diagnostic (categories or a numeric code, no paths or names).
 * It never throws, so it can never block startup.
 */
export async function auditStudentStatePermissions(
  stateDirectory: string,
  log: FailureLog,
  audit: (path: string) => Promise<WindowsAccessAudit> = auditWindowsPrivateAccess,
): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const record = permissionRecord(await audit(stateDirectory));
    if (record === null) return;
    await log.append({
      occurredAt: new Date().toISOString(),
      kind: "state-permissions",
      ...record,
    });
  } catch {
    // The diagnostic is best effort; permissions never stop the student.
  }
}
