import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Sha256DigestSchema } from "@marea/protocol";
import * as z from "zod";

import { readBoundedRegularFile } from "../../recovery/artifact.boundary.js";
import { RecoveryBundleError, type RecoveryBundleManifest } from "../../recovery/contracts.js";
import { sha256Bytes } from "../../recovery/manifest.boundary.js";
import { canonicalJsonBytes, OperationsBoundaryError } from "../canonical-encoder.js";
import {
  AuthorityLineageSchema,
  IndexGenerationSchema,
  RootIdSchema,
  type IndexInspection,
} from "../schemas.js";

/** Relative state-file path captured with the database in every authorized recovery bundle. */
export function authorityRecordPath(): string {
  return "deletion-authority.json";
}

function authorityRecordSchema() {
  return z
    .object({
      format: z.literal("marea-deletion-authority:1"),
      authorityLineage: AuthorityLineageSchema,
      rootId: RootIdSchema,
      indexGeneration: IndexGenerationSchema,
      databaseLineage: Sha256DigestSchema,
    })
    .strict();
}
export type AuthorityRecord = z.infer<ReturnType<typeof authorityRecordSchema>>;

/**
 * Writes the current deletion authority into the installation root for capture. The caller
 * holds exclusive maintenance, so the record and the database describe the same moment.
 */
export function writeAuthorityRecord(sourceRoot: string, inspection: IndexInspection): void {
  if (inspection.state !== "active" || inspection.pendingCheckpoint !== null)
    throw new OperationsBoundaryError("uncertain", "The deletion index is not ready for a backup.");
  const bytes = canonicalJsonBytes(
    authorityRecordSchema().parse({
      format: "marea-deletion-authority:1",
      authorityLineage: inspection.authorityLineage,
      rootId: inspection.rootId,
      indexGeneration: inspection.generation,
      databaseLineage: inspection.databaseLineage,
    }),
  );
  const path = join(sourceRoot, authorityRecordPath());
  const staged = `${path}.staged`;
  writeFileSync(staged, bytes);
  renameSync(staged, path);
}

/** Reads the authority record of a verified bundle, or undefined when the bundle has none. */
export function readAuthorityRecord(
  bundlePath: string,
  manifest: RecoveryBundleManifest,
): AuthorityRecord | undefined {
  const file = manifest.files.find((entry) => entry.path === authorityRecordPath());
  if (file === undefined) return undefined;
  const bytes = readBoundedRegularFile(
    join(bundlePath, file.path),
    file.sizeBytes,
    "bundle-filesystem-invalid",
  );
  if (sha256Bytes(bytes) !== file.sha256)
    throw new RecoveryBundleError("bundle-filesystem-invalid");
  return authorityRecordSchema().parse(JSON.parse(new TextDecoder().decode(bytes)));
}
