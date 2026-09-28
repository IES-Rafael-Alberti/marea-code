import { dirname, join } from "node:path";

import {
  MAX_GOVERNANCE_REQUEST_BYTES,
  RevisionIdSchema,
  Sha256DigestSchema,
} from "@marea/protocol";
import { z } from "zod";

import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import {
  currentUid,
  overlapsInstallationPaths,
  privateDescendantKind,
} from "../operator-cli/private-path.js";
import { AuthorityLineageSchema, RootIdSchema } from "../operations/schemas.js";

function configSchema() {
  const positive = z.number().int().positive();
  return z
    .object({
      version: z.literal(1),
      databasePath: z.string(),
      indexPath: z.string(),
      backupRoot: z.string(),
      authorityLineage: AuthorityLineageSchema,
      rootId: RootIdSchema,
      databaseLineage: Sha256DigestSchema,
      releaseId: RevisionIdSchema,
      limits: z.object({ fileCount: positive, fileBytes: positive, totalBytes: positive }).strict(),
      stateFiles: z.array(z.string()).max(64),
    })
    .strict();
}
/** Private OPERATIONS operations contract `<root>/config/operations.json`. */
export type OperationsConfig = z.infer<ReturnType<typeof configSchema>>;

function unavailable(): OperatorCliError {
  return new OperatorCliError("prerequisite-unavailable");
}

/**
 * Closed and explicit: the database and the deletion index are each an existing private file or
 * absent below a private directory (before initialization), and the backup root is a private
 * directory; all strictly inside the installation and outside `locks`/`config`.
 */
export function readOperationsConfig(root: string, uid = currentUid()): OperationsConfig {
  const configPath = join(root, "config", "operations.json");
  if (privateDescendantKind(root, configPath, uid) !== "file") throw unavailable();
  const config = configSchema().parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        readBoundedBytes(configPath, MAX_GOVERNANCE_REQUEST_BYTES),
      ),
    ),
  );
  const fileOrAbsent = (path: string) => {
    try {
      return privateDescendantKind(root, path, uid) === "file";
    } catch {
      const parent = dirname(path);
      return parent === root || privateDescendantKind(root, parent, uid) === "directory";
    }
  };
  const paths = [config.databasePath, config.indexPath, config.backupRoot];
  if (
    !fileOrAbsent(config.databasePath) ||
    !fileOrAbsent(config.indexPath) ||
    privateDescendantKind(root, config.backupRoot, uid) !== "directory" ||
    overlapsInstallationPaths(root, paths)
  )
    throw unavailable();
  return config;
}
