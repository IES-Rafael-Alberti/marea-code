import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

/** Explicitly adopt every presented server readback, discarding the drafts it replaces. */
export function acceptReadback(runtime: GovernanceControllerRuntime): void {
  const { classRecovery, accountRecovery, classCreateRecovery, accountCreateRecovery } =
    runtime.state;
  if (classRecovery !== null) {
    runtime.classDrafts.delete(runtime.classKey(classRecovery.centerId, classRecovery.classId));
    runtime.update({ classDraft: null, classRecovery: null });
  }
  if (accountRecovery !== null) {
    runtime.accountDrafts.delete(
      runtime.accountKey(accountRecovery.centerId, accountRecovery.userId),
    );
    runtime.update({ accountDraft: null, accountRecovery: null });
  }
  if (classCreateRecovery !== null) {
    runtime.classCreateDrafts.delete(
      runtime.classKey(classCreateRecovery.centerId, classCreateRecovery.classId),
    );
    runtime.update({ classCreateDraft: null, classCreateRecovery: null });
  }
  if (accountCreateRecovery !== null) {
    runtime.accountCreateDrafts.delete(
      runtime.accountKey(accountCreateRecovery.centerId, accountCreateRecovery.userId),
    );
    runtime.update({ accountCreateDraft: null, accountCreateRecovery: null });
  }
  runtime.update({ problem: null });
}

export function resumeClassCreateDraft(
  runtime: GovernanceControllerRuntime,
  centerId: string,
  classId: string,
): void {
  const draft = runtime.classCreateDrafts.get(runtime.classKey(centerId, classId));
  if (draft === undefined || centerId !== runtime.state.centerId) return;
  runtime.update({
    classCreateDraft: draft,
    classCreateRecovery: runtime.state.classes.find((row) => row.classId === classId) ?? null,
    problem: null,
  });
}

export function dismissClassCreateDraft(
  runtime: GovernanceControllerRuntime,
  centerId: string,
  classId: string,
): void {
  runtime.classCreateDrafts.delete(runtime.classKey(centerId, classId));
  const visible = runtime.state.classCreateDraft;
  runtime.update({
    ...(visible?.centerId === centerId && visible.classId === classId
      ? { classCreateDraft: null, classCreateRecovery: null }
      : {}),
    problem: null,
  });
}

export function resumeAccountCreateDraft(
  runtime: GovernanceControllerRuntime,
  centerId: string,
  userId: string,
): void {
  const draft = runtime.accountCreateDrafts.get(runtime.accountKey(centerId, userId));
  if (draft === undefined || centerId !== runtime.state.centerId) return;
  runtime.update({
    accountCreateDraft: draft,
    accountCreateRecovery: runtime.state.accounts.find((row) => row.userId === userId) ?? null,
    problem: null,
  });
}

export function dismissAccountCreateDraft(
  runtime: GovernanceControllerRuntime,
  centerId: string,
  userId: string,
): void {
  runtime.accountCreateDrafts.delete(runtime.accountKey(centerId, userId));
  const visible = runtime.state.accountCreateDraft;
  runtime.update({
    ...(visible?.centerId === centerId && visible.userId === userId
      ? { accountCreateDraft: null, accountCreateRecovery: null }
      : {}),
    problem: null,
  });
}
