import type { ClassExchange } from "@marea/protocol";

import type { GovernanceAccountCreateInput } from "./governance-controller-types.js";
import {
  cancelClassImport,
  confirmClassImport,
  previewClassImport,
  setImportPackage,
  stageImportText,
} from "./governance-controller-exchange.js";
import {
  createAccount,
  editAccount,
  mutateSelectedAccount,
  renameAccount,
} from "./governance-controller-mutations-account-edit.js";
import {
  createClass,
  editClass,
  renameClass,
} from "./governance-controller-mutations-class-edit.js";
import { replaceAccount, replaceMembership } from "./governance-controller-runtime-state.js";
import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

export class GovernanceControllerMutations {
  public constructor(private readonly runtime: GovernanceControllerRuntime) {}

  public setImportPackage(value: ClassExchange | null): void {
    setImportPackage(this.runtime, value);
  }

  public stageImportText(text: string): void {
    stageImportText(this.runtime, text);
  }

  public previewClassImport(): Promise<void> {
    return previewClassImport(this.runtime);
  }

  public confirmClassImport(): Promise<void> {
    return confirmClassImport(this.runtime);
  }

  public cancelClassImport(): Promise<void> {
    return cancelClassImport(this.runtime);
  }

  public editClass(displayName: string): void {
    editClass(this.runtime, displayName);
  }

  public createClass(classId: string, displayName: string): Promise<void> {
    return createClass(this.runtime, classId, displayName);
  }

  public renameClass(): Promise<void> {
    return renameClass(this.runtime);
  }

  public editAccount(displayName: string): void {
    editAccount(this.runtime, displayName);
  }

  public createAccount(input: GovernanceAccountCreateInput): Promise<void> {
    return createAccount(this.runtime, input);
  }

  public renameAccount(): Promise<void> {
    return renameAccount(this.runtime);
  }

  public changeAccountState(state: "active" | "disabled"): Promise<void> {
    return mutateSelectedAccount(
      this.runtime,
      (row, context) =>
        this.runtime.client.changeAccountState(
          { centerId: context.centerId, userId: row.userId, state, expectedVersion: row.version },
          this.runtime.abort.signal,
        ),
      ({ account }, row, context) => {
        if (account.centerId !== context.centerId || account.userId !== row.userId) {
          this.runtime.update({ problem: "invalid" });
          return;
        }
        replaceAccount(this.runtime, account);
      },
    );
  }

  public revokeSessions(): Promise<void> {
    return mutateSelectedAccount(
      this.runtime,
      (row, context) =>
        this.runtime.client.revokeSessions(
          { centerId: context.centerId, userId: row.userId, expectedVersion: row.version },
          this.runtime.abort.signal,
        ),
      ({ revocation }, row) => {
        if (revocation.userId !== row.userId) {
          this.runtime.update({ problem: "invalid" });
          return;
        }
        this.runtime.update({ lastRevocation: revocation, problem: null });
      },
    );
  }

  public changeMembership(userId: string, state: "active" | "revoked"): Promise<void> {
    const context = this.runtime.classContext();
    const existing = this.runtime.state.memberships.find((item) => item.userId === userId);
    if (
      context === null ||
      !this.runtime.state.membershipsLoaded ||
      !this.runtime.state.accounts.some((item) => item.userId === userId) ||
      (existing === undefined && state === "revoked")
    ) {
      this.runtime.update({ problem: "invalid" });
      return Promise.resolve();
    }
    if (!this.runtime.canMutate()) return Promise.resolve();
    const { centerId, classId } = context;
    return this.runtime.mutate(
      () =>
        this.runtime.client.changeMembership(
          { centerId, classId, userId, state, expectedVersion: existing?.version ?? null },
          this.runtime.abort.signal,
        ),
      () => this.runtime.isCurrentClass(context),
      ({ membership }) => {
        if (
          membership.centerId !== centerId ||
          membership.classId !== classId ||
          membership.userId !== userId
        ) {
          this.runtime.update({ problem: "invalid" });
          return;
        }
        replaceMembership(this.runtime, membership);
      },
    );
  }

  public exportClass(): Promise<void> {
    const context = this.runtime.classContext();
    if (context === null || !this.runtime.state.classRevisionLoaded || !this.runtime.canMutate())
      return Promise.resolve();
    const expectedTeachingVersion = this.runtime.state.currentTeachingVersion;
    if (expectedTeachingVersion === null) {
      this.runtime.update({ problem: "invalid" });
      return Promise.resolve();
    }
    const { centerId, classId } = context;
    return this.runtime.mutate(
      () =>
        this.runtime.client.exportClass(
          { centerId, classId, expectedTeachingVersion },
          this.runtime.abort.signal,
        ),
      () => this.runtime.isCurrentClass(context),
      (response) => {
        this.runtime.update({ exportedPackage: response.package, problem: null });
      },
    );
  }
}
