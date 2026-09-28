import type {
  GovernanceAccount,
  GovernanceClass,
  ImportPreview,
  Membership,
} from "@marea/protocol";

import { clearedAccountScope, resetClassSelection } from "./governance-controller-scopes.js";
import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

/** Hide the class's current preview; it stays explicitly cancellable. */
export function stashImportPreview(
  runtime: GovernanceControllerRuntime,
  centerId: string,
  classId: string,
): void {
  const key = runtime.classKey(centerId, classId);
  const preview = runtime.importPreviews.get(key);
  if (preview === undefined) return;
  const stale = runtime.staleImportPreviews.get(key) ?? new Map<string, ImportPreview>();
  stale.set(preview.previewId, preview);
  runtime.staleImportPreviews.set(key, stale);
  runtime.importPreviews.delete(key);
}

export function removeImportPreview(
  runtime: GovernanceControllerRuntime,
  key: string,
  previewId: string,
): void {
  // Cancel and confirm act on the visible preview whenever one exists.
  runtime.importPreviews.delete(key);
  const stale = runtime.staleImportPreviews.get(key);
  stale?.delete(previewId);
  if (stale?.size === 0) runtime.staleImportPreviews.delete(key);
}

export function hasUnsavedClassWork(runtime: GovernanceControllerRuntime): boolean {
  const context = runtime.context();
  if (context === null) return false;
  const key = runtime.classKey(context.centerId, context.classId);
  return (
    runtime.state.pendingClassCreates.length > 0 ||
    runtime.classDrafts.has(key) ||
    runtime.importPackages.has(key) ||
    runtime.importPreviews.has(key) ||
    runtime.staleImportPreviews.has(key)
  );
}

export function hasUnsavedAccountWork(runtime: GovernanceControllerRuntime): boolean {
  const context = runtime.context();
  if (context === null) return false;
  return (
    runtime.state.pendingAccountCreates.length > 0 ||
    runtime.accountDrafts.has(runtime.accountKey(context.centerId, context.accountId))
  );
}

function replaceRow<T>(rows: readonly T[], row: T, same: (item: T) => boolean): readonly T[] {
  return rows.some(same) ? rows.map((item) => (same(item) ? row : item)) : [...rows, row];
}

export function replaceClass(runtime: GovernanceControllerRuntime, row: GovernanceClass): void {
  const changedClass = runtime.state.classId !== row.classId;
  if (changedClass) runtime.changeClassSelection();
  runtime.update({
    ...(changedClass ? resetClassSelection() : {}),
    classes: replaceRow(runtime.state.classes, row, (item) => item.classId === row.classId),
    classesLoaded: true,
    classId: row.classId,
    problem: null,
  });
}

export function replaceAccount(runtime: GovernanceControllerRuntime, row: GovernanceAccount): void {
  const changedAccount = runtime.state.accountId !== row.userId;
  if (changedAccount) runtime.invalidateAccount();
  runtime.update({
    ...(changedAccount ? clearedAccountScope() : {}),
    accounts: replaceRow(runtime.state.accounts, row, (item) => item.userId === row.userId),
    accountsLoaded: true,
    accountId: row.userId,
    problem: null,
  });
}

export function replaceMembership(runtime: GovernanceControllerRuntime, row: Membership): void {
  runtime.update({
    memberships: replaceRow(runtime.state.memberships, row, (item) => item.userId === row.userId),
    membershipsLoaded: true,
    problem: null,
  });
}
