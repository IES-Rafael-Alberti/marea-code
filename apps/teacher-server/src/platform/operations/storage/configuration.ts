import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as z from "zod";

import { AuthorityLineageSchema, RootIdSchema } from "../schemas.js";
import { Sha256DigestSchema } from "@marea/protocol";

function isPersistentPath(value: string): boolean {
  return (
    isAbsolute(value) &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).byteLength <= 4_096
  );
}

const PathSchema = z.string().superRefine((value, context) => {
  if (!isPersistentPath(value))
    context.addIssue({ code: "custom", message: "path must be an absolute persistent path" });
});

const storageShape = Object.create(null) as {
  installationRoot: typeof PathSchema;
  databasePath: typeof PathSchema;
  indexPath: typeof PathSchema;
  authorityLineage: typeof AuthorityLineageSchema;
  rootId: typeof RootIdSchema;
  databaseLineage: typeof Sha256DigestSchema;
};
storageShape.installationRoot = PathSchema;
storageShape.databasePath = PathSchema;
storageShape.indexPath = PathSchema;
storageShape.authorityLineage = AuthorityLineageSchema;
storageShape.rootId = RootIdSchema;
storageShape.databaseLineage = Sha256DigestSchema;

export const StorageConfigurationSchema = z
  .object(storageShape)
  .strict()
  .superRefine((value, context) => {
    if (resolve(value.databasePath) === resolve(value.indexPath)) {
      context.addIssue({
        code: "custom",
        path: ["indexPath"],
        message: "database and index paths must differ",
      });
    }
  });

export type StorageConfiguration = z.infer<typeof StorageConfigurationSchema>;

export function parseStorageConfiguration(input: unknown): StorageConfiguration {
  const parsed = StorageConfigurationSchema.parse(input);
  return Object.freeze({
    ...parsed,
    installationRoot: resolve(parsed.installationRoot),
    databasePath: resolve(parsed.databasePath),
    indexPath: resolve(parsed.indexPath),
  });
}

/** Canonicalize existing parents/files at the explicit storage-open boundary. */
export function canonicalizeStorageConfiguration(
  input: StorageConfiguration,
): StorageConfiguration {
  const parsed = parseStorageConfiguration(input);
  const rootStat = lstatSync(parsed.installationRoot, { throwIfNoEntry: false });
  if (rootStat === undefined || rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error("installation root cannot be physically verified");
  const canonicalRoot = realpathSync.native(parsed.installationRoot);
  const canonicalPath = (value: string): string => {
    const rootRelative = relative(parsed.installationRoot, value);
    if (rootRelative.startsWith("..") || isAbsolute(rootRelative))
      throw new Error("storage path must remain under installation root");
    let parent: string;
    try {
      parent = realpathSync.native(dirname(value));
    } catch {
      throw new Error("storage path parent cannot be physically verified");
    }
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory())
      throw new Error("storage path parent cannot be physically verified");
    const canonicalRelative = relative(canonicalRoot, parent);
    if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative))
      throw new Error("storage path must remain under installation root");
    const leaf = lstatSync(value, { throwIfNoEntry: false });
    if (leaf !== undefined) {
      if (leaf.isSymbolicLink()) throw new Error("storage path cannot be symbolic link");
      if (!leaf.isFile() || leaf.nlink !== 1) throw new Error("storage path is not a regular file");
    }
    return join(parent, basename(value));
  };
  const databasePath = canonicalPath(parsed.databasePath);
  const indexPath = canonicalPath(parsed.indexPath);
  if (databasePath === indexPath) throw new Error("database and index paths must differ");
  return Object.freeze({ ...parsed, installationRoot: canonicalRoot, databasePath, indexPath });
}
