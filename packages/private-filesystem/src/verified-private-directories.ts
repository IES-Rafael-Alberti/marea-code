import { realpathSync } from "node:fs";

/**
 * Directories whose private ACL was secured and verified during this process.
 * Keyed by realpath so case/relative aliases of the same directory share one
 * entry. Once secured, a directory removes foreign ACEs and inherited grants,
 * so no foreign writer can modify it or the files it later creates; that is
 * what makes re-verification redundant (see SECURITY.md).
 */
const verifiedDirectories = new Set<string>();

/** Record a directory whose private ACL was secured and verified this process. */
export function markVerifiedPrivateDirectory(path: string): void {
  try {
    verifiedDirectories.add(realpathSync(path));
  } catch {
    // A directory that vanished after verification cannot be memoized; the next
    // secure or read will re-verify it (or fail) from scratch.
  }
}

/** True when `path` resolves to a directory already verified this process. */
export function isVerifiedPrivateDirectory(path: string): boolean {
  try {
    return verifiedDirectories.has(realpathSync(path));
  } catch {
    return false;
  }
}
