import { resetCenterScope } from "./governance-controller-scopes.js";
import { loadAccess, loadCenters } from "./governance-controller-navigation-access.js";
import {
  loadAccounts,
  loadClasses,
  loadMemberships,
} from "./governance-controller-navigation-lists.js";
import { loadClassRevision, openClass } from "./governance-controller-navigation-class.js";
import {
  acceptReadback,
  dismissAccountCreateDraft,
  dismissClassCreateDraft,
  resumeAccountCreateDraft,
  resumeClassCreateDraft,
} from "./governance-controller-navigation-drafts.js";
import {
  hasUnsavedAccountWork,
  hasUnsavedClassWork,
} from "./governance-controller-runtime-state.js";
import type { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

export class GovernanceControllerNavigation {
  public constructor(private readonly runtime: GovernanceControllerRuntime) {}

  public async load(): Promise<void> {
    await loadAccess(this.runtime);
    await loadCenters(this.runtime);
  }

  public loadAccess(): Promise<void> {
    return loadAccess(this.runtime);
  }

  public loadCenters(): Promise<void> {
    return loadCenters(this.runtime);
  }

  public selectCenter(centerId: string): Promise<void> {
    if (!this.isSelectableCenter(centerId) || centerId === this.runtime.state.centerId)
      return Promise.resolve();
    if (hasUnsavedClassWork(this.runtime) || hasUnsavedAccountWork(this.runtime)) {
      this.runtime.update({ pendingCenterId: centerId });
      return Promise.resolve();
    }
    return this.switchCenter(centerId);
  }

  public confirmCenterSwitch(discard: boolean): Promise<void> {
    const target = this.runtime.state.pendingCenterId;
    if (target === null) return Promise.resolve();
    if (!discard || !this.isSelectableCenter(target)) {
      this.runtime.update({ pendingCenterId: null });
      return Promise.resolve();
    }
    return this.switchCenter(target);
  }

  public loadClasses(): Promise<void> {
    return loadClasses(this.runtime);
  }

  public loadAccounts(): Promise<void> {
    return loadAccounts(this.runtime);
  }

  public selectClass(classId: string): Promise<void> {
    if (classId === this.runtime.state.classId) return Promise.resolve();
    if (hasUnsavedClassWork(this.runtime)) {
      if (this.runtime.state.classes.some((row) => row.classId === classId))
        this.runtime.update({ pendingClassId: classId });
      return Promise.resolve();
    }
    return openClass(this.runtime, classId);
  }

  public confirmClassSwitch(discard: boolean): Promise<void> {
    const target = this.runtime.state.pendingClassId;
    if (target === null) return Promise.resolve();
    if (!discard) {
      this.runtime.update({ pendingClassId: null });
      return Promise.resolve();
    }
    return openClass(this.runtime, target);
  }

  public loadMemberships(): Promise<void> {
    return loadMemberships(this.runtime);
  }

  public loadClassRevision(): Promise<void> {
    return loadClassRevision(this.runtime);
  }

  public selectAccount(userId: string): void {
    if (userId === this.runtime.state.accountId) return;
    if (hasUnsavedAccountWork(this.runtime)) {
      if (this.runtime.state.accounts.some((row) => row.userId === userId))
        this.runtime.update({ pendingAccountId: userId });
      return;
    }
    this.openAccount(userId);
  }

  public confirmAccountSwitch(discard: boolean): void {
    const target = this.runtime.state.pendingAccountId;
    if (target === null) return;
    if (!discard) {
      this.runtime.update({ pendingAccountId: null });
      return;
    }
    this.openAccount(target);
  }

  public async reload(): Promise<void> {
    await Promise.all([this.loadClasses(), this.loadAccounts()]);
    await Promise.all([this.loadMemberships(), this.loadClassRevision()]);
  }

  public acceptReadback(): void {
    acceptReadback(this.runtime);
  }

  public resumeClassCreateDraft(centerId: string, classId: string): void {
    resumeClassCreateDraft(this.runtime, centerId, classId);
  }

  public dismissClassCreateDraft(centerId: string, classId: string): void {
    dismissClassCreateDraft(this.runtime, centerId, classId);
  }

  public resumeAccountCreateDraft(centerId: string, userId: string): void {
    resumeAccountCreateDraft(this.runtime, centerId, userId);
  }

  public dismissAccountCreateDraft(centerId: string, userId: string): void {
    dismissAccountCreateDraft(this.runtime, centerId, userId);
  }

  /** Centers are listed only after administrator access and cleared on every refresh. */
  private isSelectableCenter(centerId: string): boolean {
    return this.runtime.state.centers.some((center) => center.centerId === centerId);
  }

  private switchCenter(centerId: string): Promise<void> {
    this.runtime.invalidateCenter();
    this.runtime.update({ ...resetCenterScope(centerId), problem: null });
    return this.reload();
  }

  private openAccount(userId: string): void {
    const context = this.runtime.context();
    if (context === null || !this.runtime.state.accounts.some((row) => row.userId === userId))
      return;
    const key = this.runtime.accountKey(context.centerId, userId);
    this.runtime.invalidateAccount();
    this.runtime.update({
      accountId: userId,
      accountDraft: this.runtime.accountDrafts.get(key) ?? null,
      accountRecovery: null,
      accountCreateRecovery: null,
      accountCreateDraft: this.runtime.accountCreateDrafts.get(key) ?? null,
      lastRevocation: null,
      pendingAccountId: null,
      problem: null,
    });
  }
}
