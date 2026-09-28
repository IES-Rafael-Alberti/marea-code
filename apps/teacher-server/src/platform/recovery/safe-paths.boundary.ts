import { lstatSync, realpathSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import type { RecoveryErrorCode } from "./contracts.js";
import { RecoveryBundleError } from "./contracts.js";

export function validateBundleRelativePath(value: string): string {
  // Manifest paths have one portable spelling, independent of the executing host.
  const normalized = posix.normalize(value);
  if (
    value.includes("\\") ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32) ||
    /[<>:"|?*]/u.test(value) ||
    posix.isAbsolute(normalized) ||
    normalized.startsWith("..") ||
    value !== normalized ||
    value.endsWith("/") ||
    value
      .split("/")
      .some(
        (part) =>
          /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  ) {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
  return normalized;
}

export function failWithFile(code: RecoveryErrorCode): never {
  throw new RecoveryBundleError(code);
}

export function safeArtifactPath(
  rootPath: string,
  relativePath: string,
  code: RecoveryErrorCode,
): string {
  const absolutePath = join(rootPath, relativePath);
  let descriptor;
  try {
    descriptor = lstatSync(absolutePath);
  } catch {
    return absolutePath;
  }
  if (!descriptor.isFile() || descriptor.nlink !== 1) failWithFile(code);
  const realPath = realpathSync(absolutePath);
  const realRoot = realpathSync(rootPath);
  if (relative(realRoot, realPath).split(sep).join("/") !== relativePath) failWithFile(code);
  return absolutePath;
}
