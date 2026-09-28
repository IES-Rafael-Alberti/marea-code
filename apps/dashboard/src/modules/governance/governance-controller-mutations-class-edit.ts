import { RevisionIdSchema, SafeDisplayNameSchema } from "@marea/protocol";

import { replaceClass } from "./governance-controller-runtime-state.js";
import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

export function editClass(runtime: GovernanceControllerRuntime, displayName: string): void {
  const row = runtime.selectedClass();
  if (row === undefined) return;
  if (!SafeDisplayNameSchema.safeParse(displayName).success) {
    runtime.update({ problem: "invalid" });
    return;
  }
  const draft = {
    centerId: row.centerId,
    classId: row.classId,
    displayName,
    expectedVersion: row.version,
  };
  runtime.classDrafts.set(runtime.classKey(row.centerId, row.classId), draft);
  runtime.update({ classDraft: draft, classRecovery: null, problem: null });
}

export function createClass(
  runtime: GovernanceControllerRuntime,
  classId: string,
  displayName: string,
): Promise<void> {
  const context = runtime.context();
  if (
    context === null ||
    !RevisionIdSchema.safeParse(classId).success ||
    !SafeDisplayNameSchema.safeParse(displayName).success
  ) {
    runtime.update({ problem: "invalid" });
    return Promise.resolve();
  }
  if (!runtime.state.classesLoaded || !runtime.canMutate()) return Promise.resolve();
  const { centerId } = context;
  const draft = { centerId, classId, displayName };
  const key = runtime.classKey(centerId, classId);
  runtime.classCreateDrafts.set(key, draft);
  runtime.update({ classCreateDraft: draft, classCreateRecovery: null, problem: null });
  return runtime.mutate(
    () =>
      runtime.client.createClass(
        { centerId, classId, displayName, expectedVersion: null },
        runtime.abort.signal,
      ),
    () => runtime.isCurrentCenter(context.centerEpoch),
    ({ classroom }) => {
      if (classroom.centerId !== centerId || classroom.classId !== classId) {
        runtime.update({ problem: "invalid" });
        return;
      }
      replaceClass(runtime, classroom);
      runtime.classCreateDrafts.delete(key);
      runtime.update({ classCreateDraft: null, classCreateRecovery: null });
    },
  );
}

export function renameClass(runtime: GovernanceControllerRuntime): Promise<void> {
  const draft = runtime.state.classDraft;
  const context = runtime.classContext();
  if (draft === null || context === null || !runtime.canMutate()) return Promise.resolve();
  const key = runtime.classKey(draft.centerId, draft.classId);
  return runtime.mutate(
    () => runtime.client.renameClass(draft, runtime.abort.signal),
    () => runtime.isCurrentClass(context),
    ({ classroom }) => {
      if (classroom.centerId !== draft.centerId || classroom.classId !== draft.classId) {
        runtime.update({ problem: "invalid" });
        return;
      }
      replaceClass(runtime, classroom);
      const latest = runtime.classDrafts.get(key);
      if (latest === draft) {
        runtime.classDrafts.delete(key);
        runtime.update({ classDraft: null, classRecovery: null });
        return;
      }
      // A newer edit keeps its text but is rebased onto the returned opaque version.
      const rebased = { ...(latest ?? draft), expectedVersion: classroom.version };
      runtime.classDrafts.set(key, rebased);
      runtime.update({ classDraft: rebased, classRecovery: null });
    },
  );
}
