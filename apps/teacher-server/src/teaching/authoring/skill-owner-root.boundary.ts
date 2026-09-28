import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SkillAuthoringError } from "./errors.js";

export function canonicalOwnerRoot(path: string): string {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) return path;
    return realpathSync(path);
  } catch (error) {
    if (isMissingOwnerPath(error)) return join(canonicalParent(dirname(path)), basename(path));
    throw rootInspectionFailure(path);
  }
}

/** Canonicalize the nearest existing directory before an owner root is created. */
function canonicalParent(path: string): string {
  try {
    if (!statSync(path).isDirectory()) throw rootInspectionFailure(path);
    return realpathSync(path);
  } catch (error) {
    if (isMissingOwnerPath(error)) return join(canonicalParent(dirname(path)), basename(path));
    throw rootInspectionFailure(path);
  }
}

function rootInspectionFailure(path: string): SkillAuthoringError {
  return new SkillAuthoringError(
    "ROOT_NOT_EXCLUSIVE",
    path,
    "The exclusive filesystem could not inspect the skill state.",
  );
}

export function isMissingOwnerPath(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}
