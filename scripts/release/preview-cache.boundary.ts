import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256, type ReleaseManifest } from "./manifest.js";

/** A cache is only a hint. Authenticate its bytes against the newly signed inventory. */
export function verifiedCachedFile(
  directory: string | undefined,
  file: ReleaseManifest["files"][number],
): Uint8Array | undefined {
  if (directory === undefined) return undefined;
  const path = join(directory, file.path);
  try {
    if (realpathSync(path) !== resolve(path)) return undefined;
    const status = lstatSync(path);
    if (!status.isFile() || status.nlink !== 1 || status.size > 512_000_000) return undefined;
    const bytes = readFileSync(path);
    return sha256(bytes) === file.sha256 ? bytes : undefined;
  } catch {
    // Unreadable or removed cache entries are downloaded instead.
  }
  return undefined;
}
