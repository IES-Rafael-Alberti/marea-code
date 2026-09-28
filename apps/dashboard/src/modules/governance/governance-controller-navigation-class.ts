import type { GovernanceClientFailure } from "./governance-contracts.js";
import { readGovernancePages } from "./governance-controller-pagination.js";
import { stashImportPreview } from "./governance-controller-runtime-state.js";
import {
  hasClassIdentity,
  isClassScoped,
  isImportPreviewExpired,
} from "./governance-controller-validation.js";
import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

export function loadClassRevision(runtime: GovernanceControllerRuntime): Promise<void> {
  const context = runtime.classContext();
  if (context === null) return Promise.resolve();
  const { centerId, classId } = context;
  const token = runtime.requests.revision.begin();
  const mutation = runtime.currentClassMutationEpoch();
  stashImportPreview(runtime, centerId, classId);
  runtime.update({
    classRevisionLoaded: false,
    currentTeachingVersion: null,
    importPreview: null,
    importPreviewReviewedId: null,
    importPreviewExpired: false,
  });
  return runtime.read(
    () => runtime.client.classRevision({ centerId, classId }, runtime.abort.signal),
    () =>
      runtime.requests.revision.isLatest(token) &&
      runtime.isCurrentClass(context) &&
      runtime.isClassMutation(mutation),
    (response) => {
      if (!hasClassIdentity(response, centerId, classId)) {
        runtime.update({ problem: "invalid" });
        return;
      }
      runtime.update({
        classRevisionLoaded: true,
        currentTeachingVersion: response.teachingVersion,
        problem: null,
      });
    },
  );
}

export function openClass(runtime: GovernanceControllerRuntime, classId: string): Promise<void> {
  const selected = runtime.context();
  if (selected === null || !runtime.state.classes.some((row) => row.classId === classId))
    return Promise.resolve();
  const { centerId } = selected;
  runtime.changeClassSelection();
  const context = runtime.scope(centerId, classId, null);
  const key = runtime.classKey(centerId, classId);
  const cached = runtime.importPreviews.get(key);
  runtime.update({
    classId,
    classDraft: runtime.classDrafts.get(key) ?? null,
    classRecovery: null,
    classCreateDraft: runtime.classCreateDrafts.get(key) ?? null,
    classCreateRecovery: null,
    accountId: null,
    accountDraft: null,
    accountRecovery: null,
    accountCreateDraft: null,
    accountCreateRecovery: null,
    exportedPackage: null,
    lastRevocation: null,
    memberships: [],
    membershipsLoaded: false,
    classRevisionLoaded: false,
    currentTeachingVersion: null,
    importPackage: runtime.importPackages.get(key) ?? null,
    importPreview: cached ?? null,
    importPreviewReviewedId: null,
    importPreviewExpired: cached !== undefined && isImportPreviewExpired(runtime, cached),
    pendingClassId: null,
    pendingAccountId: null,
    problem: null,
  });
  const current = (): boolean => runtime.isCurrentClass(context);
  return runtime.withPending(async () => {
    try {
      const [memberships, revision] = await Promise.all([
        readGovernancePages(
          (afterId) =>
            runtime.client.memberships({ centerId, classId, afterId }, runtime.abort.signal),
          (membership) => membership.userId,
          current,
        ),
        runtime.client.classRevision({ centerId, classId }, runtime.abort.signal),
      ]);
      if (!current()) return;
      if (
        !hasClassIdentity(revision, centerId, classId) ||
        !isClassScoped(memberships, centerId, classId)
      ) {
        runtime.update({ problem: "invalid" });
        return;
      }
      const preview = runtime.importPreviews.get(key);
      const visible = preview?.expectedTeachingVersion === revision.teachingVersion;
      if (!visible) stashImportPreview(runtime, centerId, classId);
      runtime.update({
        memberships,
        membershipsLoaded: true,
        classRevisionLoaded: true,
        currentTeachingVersion: revision.teachingVersion,
        importPreview: visible ? preview : null,
        importPreviewExpired: visible && isImportPreviewExpired(runtime, preview),
        problem: null,
      });
    } catch (error) {
      runtime.handleFailure(error as Partial<GovernanceClientFailure> | undefined, current);
    }
  });
}
