import { chmodSync, lstatSync } from "node:fs";
import { checkWindowsPrivatePath, windowsPrivateKind } from "./windows-acl.boundary.js";
import { PrivateFilesystemError } from "./private-filesystem-error.js";

export { checkWindowsPrivatePath, windowsPrivateKind } from "./windows-acl.boundary.js";
export { PrivateFilesystemError } from "./private-filesystem-error.js";
export type { WindowsPrivateFailureReason } from "./private-filesystem-error.js";
export {
  isVerifiedPrivateDirectory,
  markVerifiedPrivateDirectory,
} from "./verified-private-directories.js";

const SECURE_ERROR_MESSAGE = "Private filesystem permissions could not be established.";

/** POSIX uid; Windows ownership is checked against the current SID by the ACL adapter. */
export function currentOwnerId(): number {
  if (process.platform === "win32") return 0;
  return (process.getuid as () => number)();
}

/** Rejects links, untrusted ownership and permissions that expose private state. */
export function inspectPrivatePath(
  path: string,
  uid = currentOwnerId(),
): "directory" | "file" | undefined {
  if (process.platform === "win32")
    return uid === 0 ? windowsPrivateKind(path, "inspect") : undefined;
  const status = lstatSync(path);
  if ((status.mode & 0o077) !== 0 || status.uid !== uid) return undefined;
  if (status.isDirectory()) return "directory";
  return status.isFile() ? "file" : undefined;
}

/** Apply before writing secrets; Windows directory grants inherit to future DB/WAL/lock files. */
export function securePrivatePath(path: string, mode: 0o600 | 0o700): void {
  if (process.platform === "win32") {
    secureWindowsPrivatePath(path, mode);
    return;
  }
  chmodSync(path, mode);
}

function secureWindowsPrivatePath(path: string, mode: 0o600 | 0o700): void {
  const expected = mode === 0o700 ? "directory" : "file";
  let kind: "directory" | "file";
  try {
    kind = checkWindowsPrivatePath(path, "secure");
  } catch (error) {
    if (error instanceof PrivateFilesystemError) {
      throw new PrivateFilesystemError(error.diagnosticCode, SECURE_ERROR_MESSAGE);
    }
    throw error;
  }
  if (kind !== expected) {
    throw new PrivateFilesystemError("private-fs.unexpected", SECURE_ERROR_MESSAGE);
  }
}
