import { readGovernancePages } from "./governance-controller-pagination.js";
import { clearedAccountScope, clearedClassScope } from "./governance-controller-scopes.js";
import { isCenterScoped, isClassScoped } from "./governance-controller-validation.js";
import type {
  GovernanceControllerRuntime,
  LatestRequest,
} from "./governance-controller-runtime.js";

function readScopedPages<T>(
  runtime: GovernanceControllerRuntime,
  request: LatestRequest,
  scopeCurrent: () => boolean,
  read: (afterId: string | null) => Promise<{ items: readonly T[]; nextAfterId: string | null }>,
  idOf: (item: T) => string,
  adopt: (items: readonly T[]) => void,
): Promise<void> {
  const token = request.begin();
  const current = (): boolean => request.isLatest(token) && scopeCurrent();
  return runtime.read(() => readGovernancePages(read, idOf, current), current, adopt);
}

export function loadClasses(runtime: GovernanceControllerRuntime): Promise<void> {
  const context = runtime.context();
  if (context === null) return Promise.resolve();
  const { centerId } = context;
  return readScopedPages(
    runtime,
    runtime.requests.classes,
    () => runtime.isCurrentClass(context),
    (afterId) => runtime.client.classes({ centerId, afterId }, runtime.abort.signal),
    (classroom) => classroom.classId,
    (classes) => {
      if (!isCenterScoped(classes, centerId)) {
        runtime.update({ problem: "invalid" });
        return;
      }
      const { classDraft, classCreateDraft, classId, pendingClassId } = runtime.state;
      const present = (id: string | null): boolean => classes.some((row) => row.classId === id);
      const selectedMissing = classId !== null && !present(classId);
      if (selectedMissing) runtime.invalidateClass();
      // A reload's server row is presented for explicit adoption when a draft targets it.
      runtime.update({
        ...(selectedMissing ? clearedClassScope() : {}),
        classes,
        classesLoaded: true,
        classRecovery: classes.find((row) => row.classId === classDraft?.classId) ?? null,
        classCreateRecovery:
          classes.find((row) => row.classId === classCreateDraft?.classId) ?? null,
        pendingClassId: !selectedMissing && present(pendingClassId) ? pendingClassId : null,
        problem: null,
      });
    },
  );
}

export function loadAccounts(runtime: GovernanceControllerRuntime): Promise<void> {
  const context = runtime.context();
  if (context === null) return Promise.resolve();
  const { centerId } = context;
  return readScopedPages(
    runtime,
    runtime.requests.accounts,
    () => runtime.isCurrentAccount(context),
    (afterId) => runtime.client.accounts({ centerId, afterId }, runtime.abort.signal),
    (account) => account.userId,
    (accounts) => {
      if (!isCenterScoped(accounts, centerId)) {
        runtime.update({ problem: "invalid" });
        return;
      }
      const { accountDraft, accountCreateDraft, accountId, pendingAccountId } = runtime.state;
      const present = (id: string | null): boolean => accounts.some((row) => row.userId === id);
      const selectedMissing = accountId !== null && !present(accountId);
      if (selectedMissing) runtime.invalidateAccount();
      // A reload's server row is presented for explicit adoption when a draft targets it.
      runtime.update({
        ...(selectedMissing ? clearedAccountScope() : {}),
        accounts,
        accountsLoaded: true,
        accountRecovery: accounts.find((row) => row.userId === accountDraft?.userId) ?? null,
        accountCreateRecovery:
          accounts.find((row) => row.userId === accountCreateDraft?.userId) ?? null,
        pendingAccountId: !selectedMissing && present(pendingAccountId) ? pendingAccountId : null,
        problem: null,
      });
    },
  );
}

export function loadMemberships(runtime: GovernanceControllerRuntime): Promise<void> {
  const context = runtime.classContext();
  if (context === null) return Promise.resolve();
  const { centerId, classId } = context;
  return readScopedPages(
    runtime,
    runtime.requests.memberships,
    () => runtime.isCurrentClass(context),
    (afterId) => runtime.client.memberships({ centerId, classId, afterId }, runtime.abort.signal),
    (membership) => membership.userId,
    (memberships) => {
      if (!isClassScoped(memberships, centerId, classId)) {
        runtime.update({ problem: "invalid" });
        return;
      }
      runtime.update({ memberships, membershipsLoaded: true, problem: null });
    },
  );
}
