import type { ClassExchange } from "@marea/protocol";

import type { GovernanceAccountCreateInput } from "./governance-controller-types.js";
import type {
  GovernanceControllerActions,
  GovernanceControllerClient,
  GovernanceState,
} from "./governance-controller-contracts.js";
import { GovernanceControllerMutations } from "./governance-controller-mutations.js";
import { GovernanceControllerNavigation } from "./governance-controller-navigation.js";
import { GovernanceControllerRuntime } from "./governance-controller-runtime.js";

/** Public administrator controller facade; the view consumes this only. */
export class GovernanceController implements GovernanceControllerActions {
  private readonly runtime: GovernanceControllerRuntime;
  private readonly navigation: GovernanceControllerNavigation;
  private readonly mutations: GovernanceControllerMutations;

  public constructor(
    client: GovernanceControllerClient,
    changed: (state: GovernanceState) => void,
    now: () => number = () => Date.now(),
  ) {
    this.runtime = new GovernanceControllerRuntime(client, changed, now);
    this.navigation = new GovernanceControllerNavigation(this.runtime);
    this.mutations = new GovernanceControllerMutations(this.runtime);
  }

  public get state(): GovernanceState {
    return this.runtime.state;
  }

  public load(): Promise<void> {
    return this.navigation.load();
  }
  public loadAccess(): Promise<void> {
    return this.navigation.loadAccess();
  }
  public loadCenters(): Promise<void> {
    return this.navigation.loadCenters();
  }
  public selectCenter(centerId: string): Promise<void> {
    return this.navigation.selectCenter(centerId);
  }
  public confirmCenterSwitch(discard: boolean): Promise<void> {
    return this.navigation.confirmCenterSwitch(discard);
  }
  public loadClasses(): Promise<void> {
    return this.navigation.loadClasses();
  }
  public loadAccounts(): Promise<void> {
    return this.navigation.loadAccounts();
  }
  public selectClass(classId: string): Promise<void> {
    return this.navigation.selectClass(classId);
  }
  public confirmClassSwitch(discard: boolean): Promise<void> {
    return this.navigation.confirmClassSwitch(discard);
  }
  public loadMemberships(): Promise<void> {
    return this.navigation.loadMemberships();
  }
  public loadClassRevision(): Promise<void> {
    return this.navigation.loadClassRevision();
  }
  public selectAccount(userId: string): void {
    this.navigation.selectAccount(userId);
  }
  public confirmAccountSwitch(discard: boolean): void {
    this.navigation.confirmAccountSwitch(discard);
  }
  public reload(): Promise<void> {
    return this.navigation.reload();
  }
  public acceptReadback(): void {
    this.navigation.acceptReadback();
  }
  public resumeClassCreateDraft(centerId: string, classId: string): void {
    this.navigation.resumeClassCreateDraft(centerId, classId);
  }
  public dismissClassCreateDraft(centerId: string, classId: string): void {
    this.navigation.dismissClassCreateDraft(centerId, classId);
  }
  public resumeAccountCreateDraft(centerId: string, userId: string): void {
    this.navigation.resumeAccountCreateDraft(centerId, userId);
  }
  public dismissAccountCreateDraft(centerId: string, userId: string): void {
    this.navigation.dismissAccountCreateDraft(centerId, userId);
  }
  public editClass(displayName: string): void {
    this.mutations.editClass(displayName);
  }
  public createClass(classId: string, displayName: string): Promise<void> {
    return this.mutations.createClass(classId, displayName);
  }
  public renameClass(): Promise<void> {
    return this.mutations.renameClass();
  }
  public editAccount(displayName: string): void {
    this.mutations.editAccount(displayName);
  }
  public createAccount(input: GovernanceAccountCreateInput): Promise<void> {
    return this.mutations.createAccount(input);
  }
  public renameAccount(): Promise<void> {
    return this.mutations.renameAccount();
  }
  public changeAccountState(state: "active" | "disabled"): Promise<void> {
    return this.mutations.changeAccountState(state);
  }
  public changeMembership(userId: string, state: "active" | "revoked"): Promise<void> {
    return this.mutations.changeMembership(userId, state);
  }
  public revokeSessions(): Promise<void> {
    return this.mutations.revokeSessions();
  }
  public exportClass(): Promise<void> {
    return this.mutations.exportClass();
  }
  public setImportPackage(value: ClassExchange | null): void {
    this.mutations.setImportPackage(value);
  }
  public stageImportText(text: string): void {
    this.mutations.stageImportText(text);
  }
  public previewClassImport(): Promise<void> {
    return this.mutations.previewClassImport();
  }
  public confirmClassImport(): Promise<void> {
    return this.mutations.confirmClassImport();
  }
  public cancelClassImport(): Promise<void> {
    return this.mutations.cancelClassImport();
  }
  public dispose(): void {
    this.runtime.dispose();
  }
}
