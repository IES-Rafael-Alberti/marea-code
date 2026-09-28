import type { GovernanceAccount } from "@marea/protocol";
import { CredentialLoginSchema, RevisionIdSchema, SafeDisplayNameSchema } from "@marea/protocol";

import type { GovernanceAccountCreateInput } from "./governance-controller-types.js";
import { replaceAccount } from "./governance-controller-runtime-state.js";
import type {
  GovernanceContext,
  GovernanceControllerRuntime,
} from "./governance-controller-runtime.js";

export function editAccount(runtime: GovernanceControllerRuntime, displayName: string): void {
  const row = runtime.selectedAccount();
  if (row === undefined) return;
  if (!SafeDisplayNameSchema.safeParse(displayName).success) {
    runtime.update({ problem: "invalid" });
    return;
  }
  const draft = {
    centerId: row.centerId,
    userId: row.userId,
    displayName,
    expectedVersion: row.version,
  };
  runtime.accountDrafts.set(runtime.accountKey(row.centerId, row.userId), draft);
  runtime.update({ accountDraft: draft, accountRecovery: null, problem: null });
}

function validCreateInput(
  runtime: GovernanceControllerRuntime,
  input: GovernanceAccountCreateInput,
) {
  return (
    RevisionIdSchema.safeParse(input.userId).success &&
    SafeDisplayNameSchema.safeParse(input.displayName).success &&
    CredentialLoginSchema.safeParse(input.login).success &&
    (input.classId === null || runtime.state.classes.some((row) => row.classId === input.classId))
  );
}

export function createAccount(
  runtime: GovernanceControllerRuntime,
  input: GovernanceAccountCreateInput,
): Promise<void> {
  const context = runtime.context();
  if (context === null || !validCreateInput(runtime, input)) {
    runtime.update({ problem: "invalid" });
    return Promise.resolve();
  }
  if (!runtime.state.accountsLoaded || !runtime.canMutate()) return Promise.resolve();
  const { centerId } = context;
  const draft = { ...input, centerId };
  const key = runtime.accountKey(centerId, input.userId);
  runtime.accountCreateDrafts.set(key, draft);
  runtime.update({ accountCreateDraft: draft, accountCreateRecovery: null, problem: null });
  return runtime.mutate(
    () => runtime.client.createAccount({ ...draft, expectedVersion: null }, runtime.abort.signal),
    () => runtime.isCurrentCenter(context.centerEpoch),
    ({ account }) => {
      if (account.centerId !== centerId || account.userId !== input.userId) {
        runtime.update({ problem: "invalid" });
        return;
      }
      replaceAccount(runtime, account);
      runtime.accountCreateDrafts.delete(key);
      runtime.update({ accountCreateDraft: null, accountCreateRecovery: null });
    },
  );
}

export function renameAccount(runtime: GovernanceControllerRuntime): Promise<void> {
  const draft = runtime.state.accountDraft;
  const context = runtime.context();
  if (draft === null || context === null || !runtime.canMutate()) return Promise.resolve();
  const key = runtime.accountKey(draft.centerId, draft.userId);
  return runtime.mutate(
    () => runtime.client.renameAccount(draft, runtime.abort.signal),
    () => runtime.isCurrentAccount(context),
    ({ account }) => {
      if (account.centerId !== draft.centerId || account.userId !== draft.userId) {
        runtime.update({ problem: "invalid" });
        return;
      }
      replaceAccount(runtime, account);
      const latest = runtime.accountDrafts.get(key);
      if (latest === draft) {
        runtime.accountDrafts.delete(key);
        runtime.update({ accountDraft: null, accountRecovery: null });
        return;
      }
      // A newer edit keeps its text but is rebased onto the returned opaque version.
      const rebased = { ...(latest ?? draft), expectedVersion: account.version };
      runtime.accountDrafts.set(key, rebased);
      runtime.update({ accountDraft: rebased, accountRecovery: null });
    },
  );
}

export function mutateSelectedAccount<T>(
  runtime: GovernanceControllerRuntime,
  operation: (row: GovernanceAccount, context: GovernanceContext) => Promise<T>,
  adopt: (response: T, row: GovernanceAccount, context: GovernanceContext) => void,
): Promise<void> {
  const row = runtime.selectedAccount();
  if (row === undefined || runtime.disposed || !runtime.canMutate()) return Promise.resolve();
  const context = runtime.scope(row.centerId, runtime.state.classId, row.userId);
  return runtime.mutate(
    () => operation(row, context),
    () => runtime.isCurrentAccount(context),
    (response) => {
      adopt(response, row, context);
    },
  );
}
