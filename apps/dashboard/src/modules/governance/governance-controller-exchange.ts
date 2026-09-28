import { ClassExchangeSchema, type ClassExchange } from "@marea/protocol";

import { removeImportPreview, stashImportPreview } from "./governance-controller-runtime-state.js";
import { parseClassExchangeText } from "./governance-exchange-text.boundary.js";
import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";
import { isImportPreviewExpired } from "./governance-controller-validation.js";

const hiddenPreview = {
  importPreview: null,
  importPreviewReviewedId: null,
  importPreviewExpired: false,
} as const;

export function setImportPackage(
  runtime: GovernanceControllerRuntime,
  value: ClassExchange | null,
): void {
  const context = runtime.classContext();
  if (context === null) return;
  const parsed = value === null ? null : ClassExchangeSchema.safeParse(value);
  if (parsed?.success === false) {
    runtime.update({ problem: "invalid" });
    return;
  }
  const { centerId, classId } = context;
  const key = runtime.classKey(centerId, classId);
  stashImportPreview(runtime, centerId, classId);
  if (parsed === null) runtime.importPackages.delete(key);
  else runtime.importPackages.set(key, parsed.data);
  runtime.update({ ...hiddenPreview, importPackage: parsed?.data ?? null, problem: null });
}

export function stageImportText(runtime: GovernanceControllerRuntime, text: string): void {
  if (runtime.classContext() === null) return;
  const value = parseClassExchangeText(text);
  if (value === null) runtime.update({ problem: "invalid" });
  else setImportPackage(runtime, value);
}

export function previewClassImport(runtime: GovernanceControllerRuntime): Promise<void> {
  const context = runtime.classContext();
  if (context === null || !runtime.state.classRevisionLoaded || !runtime.canMutate())
    return Promise.resolve();
  const { centerId, classId } = context;
  const key = runtime.classKey(centerId, classId);
  const packageValue = runtime.importPackages.get(key);
  if (packageValue === undefined) {
    runtime.update({ problem: "invalid" });
    return Promise.resolve();
  }
  const expectedTeachingVersion = runtime.state.currentTeachingVersion;
  const revision = runtime.requests.revision.current();
  return runtime.mutate(
    () =>
      runtime.client.previewClassImport(
        { centerId, classId, expectedTeachingVersion, package: packageValue },
        runtime.abort.signal,
      ),
    () =>
      runtime.isCurrentClass(context) &&
      runtime.importPackages.get(key) === packageValue &&
      runtime.requests.revision.isLatest(revision),
    ({ preview }) => {
      if (
        preview.centerId !== centerId ||
        preview.classId !== classId ||
        preview.expectedTeachingVersion !== expectedTeachingVersion
      ) {
        runtime.update({ problem: "invalid" });
        return;
      }
      runtime.importPreviews.set(key, preview);
      runtime.update({
        ...hiddenPreview,
        importPreview: preview,
        importPreviewReviewedId: preview.previewId,
        problem: null,
      });
    },
  );
}

function conflict(runtime: GovernanceControllerRuntime): Promise<void> {
  runtime.update({ problem: "conflict" });
  return Promise.resolve();
}

/** Confirms only the visible preview produced by this session's explicit preview action. */
export function confirmClassImport(runtime: GovernanceControllerRuntime): Promise<void> {
  const context = runtime.classContext();
  if (context === null) return Promise.resolve();
  const { centerId, classId } = context;
  const key = runtime.classKey(centerId, classId);
  const preview = runtime.importPreviews.get(key);
  if (preview === undefined) return conflict(runtime);
  if (preview.previewId !== runtime.state.importPreviewReviewedId) return conflict(runtime);
  if (isImportPreviewExpired(runtime, preview)) {
    runtime.update({ importPreviewExpired: true });
    return conflict(runtime);
  }
  if (!runtime.canMutate()) return Promise.resolve();
  const packageValue = runtime.importPackages.get(key);
  return runtime.mutate(
    () =>
      runtime.client.confirmClassImport(
        { centerId, classId, previewId: preview.previewId },
        runtime.abort.signal,
      ),
    () => runtime.isCurrentClass(context),
    (response) => {
      if (response.classId !== classId) {
        runtime.update({ problem: "invalid" });
        return;
      }
      // The import is committed: revision reads that started earlier are now stale.
      runtime.markClassMutation();
      removeImportPreview(runtime, key, preview.previewId);
      const confirmedPackage = runtime.importPackages.get(key) === packageValue;
      if (confirmedPackage) runtime.importPackages.delete(key);
      runtime.update({
        ...(confirmedPackage ? { ...hiddenPreview, importPackage: null } : {}),
        classRevisionLoaded: true,
        currentTeachingVersion: response.teachingVersion,
        problem: null,
      });
    },
  );
}

export function cancelClassImport(runtime: GovernanceControllerRuntime): Promise<void> {
  const context = runtime.classContext();
  if (context === null) return Promise.resolve();
  const { centerId, classId } = context;
  const key = runtime.classKey(centerId, classId);
  const preview =
    runtime.importPreviews.get(key) ?? runtime.staleImportPreviews.get(key)?.values().next().value;
  if (preview === undefined || !runtime.canMutate()) return Promise.resolve();
  return runtime.mutate(
    () =>
      runtime.client.cancelClassImport(
        { centerId, classId, previewId: preview.previewId },
        runtime.abort.signal,
      ),
    () => runtime.isCurrentClass(context),
    (response) => {
      if (response.previewId !== preview.previewId) {
        runtime.update({ problem: "invalid" });
        return;
      }
      removeImportPreview(runtime, key, preview.previewId);
      runtime.update({ ...hiddenPreview, problem: null });
    },
  );
}
