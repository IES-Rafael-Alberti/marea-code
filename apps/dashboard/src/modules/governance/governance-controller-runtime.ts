import type {
  ClassExchange,
  GovernanceAccount,
  GovernanceClass,
  ImportPreview,
} from "@marea/protocol";

import type {
  GovernanceAccountCreateDraft,
  GovernanceActionAvailability,
  GovernanceAccountDraft,
  GovernanceClassCreateDraft,
  GovernanceClassDraft,
  GovernanceControllerClient,
  GovernanceState,
} from "./governance-controller-contracts.js";
import type { GovernanceClientFailure, GovernanceProblem } from "./governance-contracts.js";

const clearedPrivateState: Omit<GovernanceState, "busy" | "availability"> = Object.freeze({
  access: null,
  centers: [],
  centersLoaded: false,
  centerId: null,
  classes: [],
  classesLoaded: false,
  classId: null,
  accounts: [],
  accountsLoaded: false,
  accountId: null,
  memberships: [],
  membershipsLoaded: false,
  classRevisionLoaded: false,
  currentTeachingVersion: null,
  classDraft: null,
  classRecovery: null,
  classCreateDraft: null,
  classCreateRecovery: null,
  accountDraft: null,
  accountRecovery: null,
  accountCreateDraft: null,
  accountCreateRecovery: null,
  pendingClassCreates: [],
  pendingAccountCreates: [],
  exportedPackage: null,
  importPackage: null,
  importPreview: null,
  importPreviewReviewedId: null,
  importPreviewExpired: false,
  lastRevocation: null,
  pendingCenterId: null,
  pendingClassId: null,
  pendingAccountId: null,
  problem: null,
});

/** An identity-only marker; a new epoch is never equal to any earlier one. */
export type Epoch = Readonly<Record<string, never>>;

function nextEpoch(): Epoch {
  return Object.freeze({});
}

/** Lets only the most recently started request of one resource adopt its result. */
export class LatestRequest {
  private latest = nextEpoch();

  public begin(): Epoch {
    this.latest = nextEpoch();
    return this.latest;
  }

  public current(): Epoch {
    return this.latest;
  }

  public isLatest(token: Epoch): boolean {
    return token === this.latest;
  }
}

export interface GovernanceContext {
  readonly centerId: string;
  readonly classId: string | null;
  readonly accountId: string | null;
  readonly centerEpoch: Epoch;
  readonly classEpoch: Epoch;
  readonly accountEpoch: Epoch;
}

export class GovernanceControllerRuntime {
  private currentState: GovernanceState = Object.freeze({
    busy: false,
    ...clearedPrivateState,
    availability: actionAvailability(clearedPrivateState),
  });
  public readonly abort = new AbortController();
  public readonly classDrafts = new Map<string, GovernanceClassDraft>();
  public readonly accountDrafts = new Map<string, GovernanceAccountDraft>();
  public readonly classCreateDrafts = new Map<string, GovernanceClassCreateDraft>();
  public readonly accountCreateDrafts = new Map<string, GovernanceAccountCreateDraft>();
  public readonly importPackages = new Map<string, ClassExchange>();
  public readonly importPreviews = new Map<string, ImportPreview>();
  /** Previews hidden by a package/revision change remain explicitly cancellable. */
  public readonly staleImportPreviews = new Map<string, Map<string, ImportPreview>>();
  public readonly requests = {
    centers: new LatestRequest(),
    classes: new LatestRequest(),
    accounts: new LatestRequest(),
    memberships: new LatestRequest(),
    revision: new LatestRequest(),
  };
  public disposed = false;
  public mutationBusy = false;
  private pending = 0;
  private centerEpoch = nextEpoch();
  private classEpoch = nextEpoch();
  private accountEpoch = nextEpoch();
  private classMutationEpoch = nextEpoch();

  public constructor(
    public readonly client: GovernanceControllerClient,
    private readonly changed: (state: GovernanceState) => void,
    public readonly now: () => number,
  ) {}

  public get state(): GovernanceState {
    return this.currentState;
  }

  public dispose(): void {
    this.invalidateCenter();
    this.disposed = true;
    this.abort.abort();
    this.currentState = Object.freeze({ ...this.currentState, problem: null });
  }

  /** A center change, access refresh or disposal replaces every scoped epoch. */
  public invalidateCenter(): void {
    this.centerEpoch = nextEpoch();
    this.invalidateClass();
    this.invalidateAccount();
  }

  /** Replaced whenever the selected class changes. */
  public invalidateClass(): void {
    this.classEpoch = nextEpoch();
  }

  /** Replaced whenever the selected account changes. */
  public invalidateAccount(): void {
    this.accountEpoch = nextEpoch();
  }

  /** A selected-class change also ends any account selection. */
  public changeClassSelection(): void {
    this.invalidateClass();
    if (this.currentState.accountId !== null) this.invalidateAccount();
  }

  /** Revision reads started before a class mutation must not overwrite its result. */
  public markClassMutation(): void {
    this.classMutationEpoch = nextEpoch();
  }

  public currentClassMutationEpoch(): Epoch {
    return this.classMutationEpoch;
  }

  public isClassMutation(epoch: Epoch): boolean {
    return epoch === this.classMutationEpoch;
  }

  public currentCenterEpoch(): Epoch {
    return this.centerEpoch;
  }

  public isCurrentCenter(epoch: Epoch): boolean {
    return epoch === this.centerEpoch;
  }

  /** A class-scoped result is current while the selected class is unchanged. */
  public isCurrentClass(context: GovernanceContext): boolean {
    return context.classEpoch === this.classEpoch;
  }

  /** An account-scoped result is current while the selected account is unchanged. */
  public isCurrentAccount(context: GovernanceContext): boolean {
    return context.accountEpoch === this.accountEpoch;
  }

  public context(): GovernanceContext | null {
    const { centerId, classId, accountId } = this.currentState;
    if (this.disposed || centerId === null) return null;
    return this.scope(centerId, classId, accountId);
  }

  /** Captures the current epochs for a known selection. */
  public scope<C extends string | null, A extends string | null>(
    centerId: string,
    classId: C,
    accountId: A,
  ): GovernanceContext & { readonly classId: C; readonly accountId: A } {
    return {
      centerId,
      classId,
      accountId,
      centerEpoch: this.centerEpoch,
      classEpoch: this.classEpoch,
      accountEpoch: this.accountEpoch,
    };
  }

  public classContext(): (GovernanceContext & { readonly classId: string }) | null {
    const context = this.context();
    if (context === null) return null;
    const { classId } = context;
    if (classId === null) return null;
    return { ...context, classId };
  }

  /** Draft and exchange keys; a null selection never matches a stored key. */
  public classKey(centerId: string, classId: string | null): string {
    return JSON.stringify([centerId, classId]);
  }

  public accountKey(centerId: string, userId: string | null): string {
    return JSON.stringify([centerId, userId]);
  }

  public selectedClass(): GovernanceClass | undefined {
    return this.currentState.classes.find((row) => row.classId === this.currentState.classId);
  }

  public selectedAccount(): GovernanceAccount | undefined {
    return this.currentState.accounts.find((row) => row.userId === this.currentState.accountId);
  }

  public canMutate(): boolean {
    return !this.mutationBusy;
  }

  /** Invalidate all in-flight scoped work and clear private presentation. Draft maps remain. */
  public beginAccessRefresh(problem: GovernanceProblem | null = null): void {
    this.invalidateCenter();
    this.update({ ...clearedPrivateState, problem });
  }

  public update(patch: Partial<GovernanceState>): void {
    if (this.disposed) return;
    const merged = { ...this.currentState, ...patch };
    const next = {
      ...merged,
      pendingClassCreates: inCenter(this.classCreateDrafts, merged.centerId),
      pendingAccountCreates: inCenter(this.accountCreateDrafts, merged.centerId),
    };
    this.currentState = Object.freeze({ ...next, availability: actionAvailability(next) });
    this.changed(this.currentState);
  }

  public async withPending(operation: () => Promise<void>): Promise<void> {
    this.pending += 1;
    this.update({ busy: true });
    try {
      await operation();
    } finally {
      this.pending -= 1;
      this.update({ busy: this.pending > 0 });
    }
  }

  public read<T>(
    operation: () => Promise<T>,
    current: () => boolean,
    adopt: (value: T) => void,
  ): Promise<void> {
    return this.withPending(async () => {
      try {
        const value = await operation();
        if (current()) adopt(value);
      } catch (error) {
        this.handleFailure(error as Partial<GovernanceClientFailure> | undefined, current);
      }
    });
  }

  public async mutate<T>(
    operation: () => Promise<T>,
    current: () => boolean,
    adopt: (value: T) => void,
  ): Promise<void> {
    this.mutationBusy = true;
    try {
      await this.read(operation, current, adopt);
    } finally {
      this.mutationBusy = false;
    }
  }

  /**
   * Apply the client error policy uniformly, including composite navigation
   * operations that cannot use read() for their parallel requests. A forbidden
   * response is global authorization evidence even when the request is stale.
   */
  public handleFailure(
    error: Partial<GovernanceClientFailure> | undefined,
    current: () => boolean,
  ): void {
    const problem = governanceProblem(error);
    if (problem === "forbidden") this.beginAccessRefresh(problem);
    else if (current()) this.update({ problem });
  }
}

function inCenter<T extends { readonly centerId: string }>(
  drafts: ReadonlyMap<string, T>,
  centerId: string | null,
): readonly T[] {
  return [...drafts.values()].filter((draft) => draft.centerId === centerId);
}

/**
 * Loaded flags imply their scope: centers need administrator access, a loaded
 * class or account list needs a selected center, and memberships need a class.
 */
function actionAvailability(
  state: Omit<GovernanceState, "busy" | "availability">,
): GovernanceActionAvailability {
  return {
    canSelectCenter: state.centersLoaded,
    canManageClasses: state.classesLoaded,
    canManageAccounts: state.accountsLoaded,
    canManageMemberships: state.membershipsLoaded,
    canExchangeClass: state.membershipsLoaded && state.classRevisionLoaded,
  };
}

function governanceProblem(error: Partial<GovernanceClientFailure> | undefined): GovernanceProblem {
  const code = error?.code;
  switch (code) {
    case "invalid":
    case "forbidden":
    case "conflict":
    case "uncertain":
    case "unconfigured":
    case "skill-unavailable":
      return code;
    default:
      return "load";
  }
}
