import { realpath, realpathSync } from "node:fs";
import { promisify } from "node:util";

const nativeRealpath = promisify(realpath.native);

/** The operating system's own spelling: drive-letter case, long names and junction targets. */
export function canonicalPath(path: string): Promise<string> {
  return nativeRealpath(path);
}

/** Like `canonicalPath`, but a path that cannot be resolved keeps its given spelling. */
export function canonicalPathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Windows paths differ only by case; other platforms are case-sensitive. */
export function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
