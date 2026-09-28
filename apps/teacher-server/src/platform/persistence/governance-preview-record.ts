import { Buffer } from "node:buffer";
import {
  ClassExchangeSchema,
  TeachingSettingsSchema,
  RevisionIdSchema,
  UtcTimestampSchema,
  Sha256DigestSchema,
  MAX_TEACHING_CONFIGURATION_BYTES,
} from "@marea/protocol";
import type { SqliteRow } from "@marea/sqlite-storage";
import type { StoredClassImportPreview } from "../../governance/contracts.js";
import { rowText, rowNullableText, rowJson } from "./row-parser.boundary.js";
import { governanceConflict } from "./governance-store.js";
import { classExchangeDigest } from "../../governance/class-exchange-digest.js";

export function storedImportPreview(row: SqliteRow): StoredClassImportPreview {
  for (const field of ["package_json", "settings_json"]) {
    if (Buffer.byteLength(rowText(row, field)) > MAX_TEACHING_CONFIGURATION_BYTES)
      governanceConflict();
  }
  const payload = rowJson(row, "package_json", ClassExchangeSchema);
  const digest = Sha256DigestSchema.parse(rowText(row, "package_digest"));
  if (classExchangeDigest(payload) !== digest) governanceConflict();
  return Object.freeze({
    previewId: RevisionIdSchema.parse(rowText(row, "id")),
    centerId: RevisionIdSchema.parse(rowText(row, "center_id")),
    classId: RevisionIdSchema.parse(rowText(row, "class_id")),
    creator:
      rowText(row, "authority") === "operator"
        ? { kind: "operator" as const }
        : {
            kind: "administrator" as const,
            userId: RevisionIdSchema.parse(rowText(row, "user_id")),
            sessionId: RevisionIdSchema.parse(rowText(row, "session_id")),
          },
    createdAt: UtcTimestampSchema.parse(rowText(row, "created_at")),
    expiresAt: UtcTimestampSchema.parse(rowText(row, "expires_at")),
    expectedTeachingVersion: RevisionIdSchema.nullable().parse(
      rowNullableText(row, "expected_teaching_version"),
    ),
    expectedClassVersion: RevisionIdSchema.parse(rowText(row, "expected_class_version")),
    operatorFingerprint: Sha256DigestSchema.parse(rowText(row, "operator_fingerprint")),
    packageDigest: digest,
    package: payload,
    settings: rowJson(row, "settings_json", TeachingSettingsSchema),
  });
}
