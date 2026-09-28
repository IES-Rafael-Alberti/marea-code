import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { OperatorCliError } from "./errors.js";
import { currentUid, isInside, privateDescendantKind } from "./private-path.js";

export interface PreparedArtifact {
  readonly path: string;
  readonly assertParent: () => void;
}

/**
 * Validate an explicit create-only destination before domain work: a new canonical name in a
 * private installation directory outside the lock, configuration and configured source roots.
 */
export function prepareArtifact(
  root: string,
  reserved: readonly string[],
  path: string,
  uid = currentUid(),
): PreparedArtifact {
  const parent = dirname(path);
  try {
    const valid =
      join(parent, basename(path)) === path &&
      (parent === root || privateDescendantKind(root, parent, uid) === "directory") &&
      !reserved.some((entry) => isInside(path, entry)) &&
      lstatSync(path, { throwIfNoEntry: false }) === undefined;
    if (!valid) throw new Error();
    const before = lstatSync(parent);
    return {
      path,
      assertParent: () => {
        const after = lstatSync(parent);
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          (parent !== root && privateDescendantKind(root, parent, uid) !== "directory")
        )
          throw new OperatorCliError("output-failed");
      },
    };
  } catch {
    throw new OperatorCliError("invalid-input");
  }
}

export function boundedJson(value: unknown, maxBytes: number): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > maxBytes) throw new OperatorCliError("output-failed");
  return bytes;
}

/** Stage, fsync and hard-link: an existing name (even a dangling symlink) is never replaced. */
export function publishArtifact(output: PreparedArtifact | undefined, bytes: Buffer): void {
  if (output === undefined) throw new OperatorCliError("output-failed");
  const path = output.path;
  let stage: string | undefined;
  try {
    output.assertParent();
    stage = mkdtempSync(join(dirname(path), ".marea-artifact-"));
    const staged = join(stage, "artifact.json");
    const descriptor = openSync(staged, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(staged, path);
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } catch {
    throw new OperatorCliError("output-failed");
  } finally {
    if (stage !== undefined) rmSync(stage, { recursive: true });
  }
}
