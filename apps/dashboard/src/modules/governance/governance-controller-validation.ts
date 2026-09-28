import type { ImportPreview } from "@marea/protocol";

import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

interface CenterScoped {
  readonly centerId: string;
}

interface ClassScoped extends CenterScoped {
  readonly classId: string;
}

export function isCenterScoped(rows: readonly CenterScoped[], centerId: string): boolean {
  return rows.every((row) => row.centerId === centerId);
}

export function isClassScoped(
  rows: readonly ClassScoped[],
  centerId: string,
  classId: string,
): boolean {
  return rows.every((row) => hasClassIdentity(row, centerId, classId));
}

export function hasClassIdentity(value: ClassScoped, centerId: string, classId: string): boolean {
  return value.centerId === centerId && value.classId === classId;
}

export function isImportPreviewExpired(
  runtime: GovernanceControllerRuntime,
  preview: ImportPreview,
): boolean {
  return !(runtime.now() < Date.parse(preview.expiresAt));
}
