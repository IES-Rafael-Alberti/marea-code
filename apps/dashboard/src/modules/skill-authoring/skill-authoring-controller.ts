import {
  RevisionIdSchema,
  SkillAuthoringDraftSchema,
  SkillIdSchema,
  type SkillAuthoringDraft,
  type SkillAuthoringReadResponse,
} from "@marea/protocol";

import type {
  SkillAuthoringActions,
  SkillAuthoringClient,
  SkillAuthoringNavigationTarget,
  SkillAuthoringState,
} from "./skill-authoring-contracts.js";
import {
  cloneDraft,
  copyContext,
  editableDraftContext,
  immutableState,
  initialSkillAuthoringState,
  sameDraft,
  validSkillSlug,
  writeBlocked,
} from "./skill-authoring-state.boundary.js";
import {
  readSkillAuthoringCatalog,
  readSkillAuthoringClasses,
} from "./skill-authoring-controller-pagination.js";
import {
  adoptSkillAuthoringBundle,
  adoptSkillAuthoringCatalogRead,
  adoptSkillAuthoringRead,
  classifySkillAuthoringError,
} from "./skill-authoring-controller-state.js";

type OperationKind = "validate" | "write";

function missingBaseline(): SkillAuthoringDraft {
  return {
    kind: "didactic",
    slug: "__missing_baseline__",
    files: [],
  };
}

/** Owns the in-memory authoring draft and its explicit recovery boundaries. */
export class SkillAuthoringController implements SkillAuthoringActions {
  private currentState: SkillAuthoringState = initialSkillAuthoringState();
  private operationBusy = false;
  private disposed = false;
  private readonly abort = new AbortController();
  private baselineDraft: SkillAuthoringDraft | null = null;
  private recoverySlug: string | null = null;

  public constructor(
    private readonly client: SkillAuthoringClient,
    private readonly changed: (state: SkillAuthoringState) => void,
  ) {}

  public get state(): SkillAuthoringState {
    return this.currentState;
  }

  public dispose(): void {
    this.disposed = true;
    this.abort.abort();
  }

  public loadClasses(): Promise<void> {
    return this.perform(async () => {
      this.update({ classes: [], classesLoaded: false });
      const classes = await readSkillAuthoringClasses(this.client, this.abort.signal);
      const problem = this.state.problem === "load" ? null : this.state.problem;
      this.update({
        classes,
        classesLoaded: true,
        problem,
      });
    });
  }
  public selectClass(classId: string): Promise<void> {
    if (!RevisionIdSchema.safeParse(classId).success || this.disposed || this.operationBusy) {
      return Promise.resolve();
    }
    if (classId === this.state.classId && this.state.pendingTarget === null) {
      return Promise.resolve();
    }
    const target: SkillAuthoringNavigationTarget = { kind: "class", classId };
    if (this.state.dirty) {
      this.update({ pendingTarget: target });
      return Promise.resolve();
    }
    return this.openClass(classId);
  }
  public loadCatalog(classId: string): Promise<void> {
    if (!RevisionIdSchema.safeParse(classId).success || this.disposed || this.operationBusy) {
      return Promise.resolve();
    }
    if (this.state.classId !== classId) {
      if (this.state.dirty) {
        this.update({ pendingTarget: { kind: "class", classId } });
        return Promise.resolve();
      }
      return this.openClass(classId);
    }
    return this.perform(async () => {
      this.update({ catalog: [], catalogLoaded: false });
      const catalog = await readSkillAuthoringCatalog(this.client, classId, this.abort.signal);
      this.update({
        catalog,
        catalogLoaded: true,
        problem: this.state.problem === "load" ? null : this.state.problem,
      });
    });
  }
  public selectSkill(skillId: string): Promise<void> {
    if (!SkillIdSchema.safeParse(skillId).success || this.disposed || this.operationBusy) {
      return Promise.resolve();
    }
    const classId = this.state.classId;
    if (classId === null) return Promise.resolve();
    if (this.state.selectedSkillId === skillId && this.state.pendingTarget === null) {
      return Promise.resolve();
    }
    const target: SkillAuthoringNavigationTarget = { kind: "skill", classId, skillId };
    if (this.state.dirty) {
      this.update({ pendingTarget: target });
      return Promise.resolve();
    }
    return this.openCatalogSkill(classId, skillId);
  }
  public startPersonalDraft(slug: string): Promise<void> {
    if (!validSkillSlug(slug) || this.disposed || this.operationBusy) return Promise.resolve();
    const classId = this.state.classId;
    if (classId === null) return Promise.resolve();
    if (this.state.personalSlug === slug && this.state.pendingTarget === null) {
      if (this.state.problem === null) return Promise.resolve();
    }
    const target: SkillAuthoringNavigationTarget = { kind: "personal", classId, slug };
    if (this.state.dirty) {
      this.update({ pendingTarget: target });
      return Promise.resolve();
    }
    return this.openPersonal(classId, slug);
  }
  public editDraft(draft: SkillAuthoringDraft): void {
    const context = editableDraftContext(this.state, this.disposed, this.operationBusy);
    if (context === null || writeBlocked(this.state)) {
      return;
    }
    const nextDraft = cloneDraft(draft);
    const baseline = this.baselineDraft ?? missingBaseline();
    this.update({
      draft: nextDraft,
      dirty: !sameDraft(baseline, nextDraft),
      validation: null,
      problem: this.state.problem === "invalid" ? null : this.state.problem,
    });
  }
  public validateDraft(): Promise<void> {
    const context = editableDraftContext(this.state, this.disposed, this.operationBusy);
    if (context === null || writeBlocked(this.state)) {
      return Promise.resolve();
    }
    const { classId, draft } = context;
    return this.perform(async () => {
      const parsed = SkillAuthoringDraftSchema.safeParse(draft);
      if (!parsed.success) {
        this.update({ problem: "invalid", validation: null });
        return;
      }
      const response = await this.client.validate(classId, parsed.data, this.abort.signal);
      this.update({ validation: response, problem: null });
    }, "validate");
  }
  public saveDraft(_expectedDigest?: string | null): Promise<void>;
  public saveDraft(): Promise<void> {
    // The public port keeps this argument for callers, but only state-derived
    // digests may reach the server.
    // The caller's digest is intentionally discarded; only loaded state below is trusted.
    const context = editableDraftContext(this.state, this.disposed, this.operationBusy);
    if (context === null || this.state.personalSlug === null || writeBlocked(this.state)) {
      return Promise.resolve();
    }
    const { classId, draft } = context;
    return this.perform(async () => {
      const parsed = SkillAuthoringDraftSchema.safeParse(draft);
      if (!parsed.success) {
        this.update({ problem: "invalid" });
        return;
      }
      const expectedDigest =
        this.state.loadedBundle?.source === "teacher" &&
        this.state.loadedBundle.name === parsed.data.slug
          ? this.state.loadedBundle.digest
          : null;
      this.recoverySlug = parsed.data.slug;
      const response = await this.client.save(
        classId,
        parsed.data,
        expectedDigest,
        this.abort.signal,
      );
      this.adoptPersonalBundle(response.skill);
      this.recoverySlug = null;
    }, "write");
  }
  public copySkill(sourceSkillId: string, sourceDigest: string, slug: string): Promise<void> {
    const context = copyContext(
      this.state,
      this.disposed,
      this.operationBusy,
      sourceSkillId,
      sourceDigest,
      slug,
    );
    if (context === null) {
      return Promise.resolve();
    }
    const { classId } = context;
    const preserveDirtyDraft = this.state.dirty;
    this.recoverySlug = slug;
    return this.perform(async () => {
      const response = await this.client.copy(
        classId,
        sourceSkillId,
        sourceDigest,
        slug,
        this.abort.signal,
      );
      this.recoverySlug = null;
      if (preserveDirtyDraft) {
        this.update({
          pendingTarget: { kind: "personal", classId, slug },
          problem: null,
        });
        return;
      }
      this.adoptPersonalBundle(response.skill);
    }, "write");
  }
  public confirmNavigation(discard: boolean): Promise<void> {
    if (this.operationBusy) return Promise.resolve();
    const target = this.state.pendingTarget;
    if (target === null) return Promise.resolve();
    if (!discard) {
      this.update({ pendingTarget: null });
      return Promise.resolve();
    }
    if (target.kind === "class") return this.openClass(target.classId);
    if (target.kind === "skill") return this.openCatalogSkill(target.classId, target.skillId);
    return this.openPersonal(target.classId, target.slug);
  }
  public reload(): Promise<void> {
    const classId = this.state.classId;
    const slug = this.recoverySlug ?? this.state.personalSlug;
    if (classId === null || slug === null || this.state.pendingTarget !== null) {
      return Promise.resolve();
    }
    const requiresRecovery =
      this.state.dirty ||
      this.state.problem === "conflict" ||
      this.state.problem === "uncertain" ||
      this.recoverySlug !== null;
    return this.perform(
      async () => {
        const read = await this.client.readPersonal(classId, slug, this.abort.signal);
        if (requiresRecovery) {
          this.update({ recovery: read });
          return;
        }
        this.adoptRead(classId, slug, read);
      },
      undefined,
      true,
    );
  }
  public acceptReadback(): void {
    if (this.operationBusy || this.state.pendingTarget !== null) return;
    const recovery = this.state.recovery;
    if (recovery === null || this.state.classId === null) return;
    const slug = this.recoverySlug ?? this.state.personalSlug;
    if (slug === null) return;
    this.adoptRead(this.state.classId, slug, recovery);
    this.recoverySlug = null;
  }
  private openClass(classId: string): Promise<void> {
    return this.perform(async () => {
      this.resetForClass(classId);
      const catalog = await readSkillAuthoringCatalog(this.client, classId, this.abort.signal);
      this.update({ catalog, catalogLoaded: true });
    });
  }
  private openCatalogSkill(classId: string, skillId: string): Promise<void> {
    return this.perform(async () => {
      this.recoverySlug = null;
      this.update({
        classId,
        catalog: this.state.catalog,
        catalogLoaded: this.state.catalogLoaded,
        selectedSkillId: skillId,
        personalSlug: null,
        loadedBundle: null,
        editable: false,
        draft: null,
        dirty: false,
        validation: null,
        recovery: null,
        pendingTarget: null,
        problem: null,
      });
      const read = await this.client.readCatalog(classId, skillId, this.abort.signal);
      const adoption = adoptSkillAuthoringCatalogRead(classId, skillId, read);
      this.baselineDraft = adoption.baseline;
      this.update(adoption.patch);
    });
  }

  private openPersonal(classId: string, slug: string): Promise<void> {
    return this.perform(async () => {
      this.recoverySlug = null;
      this.update({
        classId,
        selectedSkillId: null,
        personalSlug: slug,
        loadedBundle: null,
        editable: true,
        draft: null,
        dirty: false,
        validation: null,
        recovery: null,
        pendingTarget: null,
        problem: null,
      });
      this.baselineDraft = null;
      const read = await this.client.readPersonal(classId, slug, this.abort.signal);
      this.adoptRead(classId, slug, read);
    });
  }

  private resetForClass(classId: string): void {
    this.baselineDraft = null;
    this.recoverySlug = null;
    this.update({
      classId,
      catalog: [],
      catalogLoaded: false,
      selectedSkillId: null,
      personalSlug: null,
      loadedBundle: null,
      editable: false,
      draft: null,
      dirty: false,
      validation: null,
      recovery: null,
      pendingTarget: null,
      problem: null,
    });
  }

  private adoptRead(classId: string, slug: string, read: SkillAuthoringReadResponse): void {
    const adoption = adoptSkillAuthoringRead(classId, slug, read);
    this.baselineDraft = adoption.baseline;
    this.update(adoption.patch);
  }

  private adoptPersonalBundle(bundle: NonNullable<SkillAuthoringReadResponse["skill"]>): void {
    const adoption = adoptSkillAuthoringBundle(bundle);
    this.baselineDraft = adoption.baseline;
    this.update(adoption.patch);
  }

  private async perform(
    operation: () => Promise<void>,
    kind?: OperationKind,
    preserveWriteProblem = false,
  ): Promise<void> {
    if (this.operationBusy || this.disposed || this.abort.signal.aborted) return;
    this.operationBusy = true;
    this.update({ busy: true });
    try {
      await operation();
    } catch (error) {
      this.update({
        problem: classifySkillAuthoringError(
          error as Error,
          kind,
          preserveWriteProblem,
          this.state.problem,
        ),
      });
    } finally {
      this.operationBusy = false;
      this.update({ busy: false });
    }
  }
  private update(patch: Partial<SkillAuthoringState>): void {
    if (this.disposed) return;
    this.currentState = immutableState({ ...this.currentState, ...patch });
    this.changed(this.currentState);
  }
}
