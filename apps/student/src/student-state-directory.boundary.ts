import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalPathOrSelf, comparablePath } from "./canonical-path.boundary.js";

function hashedDirectory(root: string, serverUrl: string, projectPath: string): string {
  const identity = createHash("sha256")
    .update(serverUrl)
    .update("\0")
    .update(projectPath)
    .digest("hex");
  return join(resolve(root), "student", identity);
}

/** Keyed by the real project folder, so every spelling of it reaches the same login and session. */
export function canonicalStateDirectory(
  root: string,
  serverUrl: string,
  projectRoot: string,
): string {
  return hashedDirectory(
    root,
    serverUrl,
    comparablePath(canonicalPathOrSelf(resolve(projectRoot))),
  );
}

/**
 * Earlier versions keyed the directory by the raw spelling of the working directory. A student who
 * only has that directory keeps their state: it is moved to the canonical name, or used in place
 * when it cannot be moved.
 */
export function locateStateDirectory(root: string, serverUrl: string, projectRoot: string): string {
  const canonical = canonicalStateDirectory(root, serverUrl, projectRoot);
  const legacy = hashedDirectory(root, serverUrl, resolve(projectRoot));
  if (existsSync(canonical) || !existsSync(legacy)) return canonical;
  try {
    renameSync(legacy, canonical);
    return canonical;
  } catch {
    return legacy;
  }
}
