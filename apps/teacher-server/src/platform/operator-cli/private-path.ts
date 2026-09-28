import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { currentOwnerId, inspectPrivatePath } from "@marea/private-filesystem";

export const currentUid = currentOwnerId;
export const privateKind = inspectPrivatePath;

export function isInside(path: string, container: string): boolean {
  const difference = relative(container, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

/** True when a configured path enters `locks`, `config` or another configured path. */
export function overlapsInstallationPaths(root: string, paths: readonly string[]): boolean {
  return paths.some((path, index) =>
    [
      join(root, "locks"),
      join(root, "config"),
      ...paths.filter((_, other) => other !== index),
    ].some((container) => isInside(path, container)),
  );
}

/** Canonical spelling (no alias or symlink) strictly below root with every component private. */
export function privateDescendantKind(
  root: string,
  path: string,
  uid: number,
): "directory" | "file" | undefined {
  if (path === root || realpathSync(path) !== path || !isInside(path, root)) return undefined;
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
    if (privateKind(parent, uid) !== "directory") return undefined;
  }
  return privateKind(path, uid);
}
