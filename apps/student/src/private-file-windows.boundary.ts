import {
  PrivateFilesystemError,
  checkWindowsPrivatePath,
  isVerifiedPrivateDirectory,
  markVerifiedPrivateDirectory,
  securePrivatePath,
} from "@marea/private-filesystem";
import { dirname } from "node:path";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

/** Secure and remember a private directory; files inside inherit its ACL. */
export function securePrivateDirectory(path: string): void {
  securePrivatePath(path, PRIVATE_DIRECTORY_MODE);
  if (process.platform === "win32") markVerifiedPrivateDirectory(path);
}

/** Protect the file on POSIX, or its verified parent directory on Windows. */
export function securePrivateFileParent(path: string): void {
  if (process.platform !== "win32") {
    securePrivatePath(path, PRIVATE_FILE_MODE);
    return;
  }
  const parent = dirname(path);
  if (!isVerifiedPrivateDirectory(parent)) securePrivateDirectory(parent);
}

/** Assert a Windows private file is protected; call only after lstat accepted a regular file. */
export function assertPrivateWindowsFileReadable(path: string): void {
  // A verified parent means this regular file inherited its protected ACL.
  if (isVerifiedPrivateDirectory(dirname(path))) return;
  let kind: "directory" | "file";
  try {
    kind = checkWindowsPrivatePath(path, "inspect");
  } catch (error) {
    if (error instanceof PrivateFilesystemError) {
      throw new PrivateFilesystemError(
        error.diagnosticCode,
        "Student state file permissions are unsafe.",
      );
    }
    throw error;
  }
  if (kind !== "file") {
    throw new PrivateFilesystemError(
      "private-fs.unexpected",
      "Student state file permissions are unsafe.",
    );
  }
}
