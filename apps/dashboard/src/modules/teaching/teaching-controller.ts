import {
  RevisionIdSchema,
  TeachingSettingsSchema,
  type TeachingCatalogEntry,
  type TeachingClassSummary,
  type TeachingConfigurationResponse,
  type TeachingSettings,
} from "@marea/protocol";

import type {
  TeachingActions,
  TeachingClient,
  TeachingClientFailure,
  TeachingProblem,
  TeachingState,
} from "./teaching-contracts.js";

const DEFAULT_SETTINGS: TeachingSettings = {
  socraticMode: "normal",
  agentMode: "tutoring",
  classInstructions: { tutoring: "", free: "" },
  selection: { didactic: [], evaluation: [] },
  automaticEvaluation: false,
};

/** Owns one teaching selection at a time with in-memory drafts and explicit recovery. */
export class TeachingController implements TeachingActions {
  public state: TeachingState = {
    busy: false,
    classes: [],
    classesLoaded: false,
    classId: null,
    catalog: [],
    configuration: null,
    operatorReady: false,
    draft: null,
    dirty: false,
    problem: null,
    recovery: null,
    pendingClassId: null,
  };
  private busy = false;
  private disposed = false;
  private readonly abort = new AbortController();

  public constructor(
    private readonly client: TeachingClient,
    private readonly changed: (state: TeachingState) => void,
  ) {}

  public dispose(): void {
    this.disposed = true;
    this.abort.abort();
  }

  public loadClasses(): Promise<void> {
    return this.perform(async () => {
      const classes: TeachingClassSummary[] = [];
      const seen = new Set<string>();
      let cursor = "";
      for (;;) {
        const page = await this.client.classes(cursor || null, this.abort.signal);
        for (const entry of page.classes) {
          if (!seen.has(entry.classId)) {
            seen.add(entry.classId);
            classes.push(entry);
          }
        }
        if (page.nextAfterClassId === null) break;
        if (page.nextAfterClassId <= cursor) throw new Error();
        cursor = page.nextAfterClassId;
        this.abort.signal.throwIfAborted();
      }
      this.update({
        classes,
        classesLoaded: true,
        problem: this.state.problem === "load" ? null : this.state.problem,
      });
    });
  }

  public selectClass(classId: string): Promise<void> {
    if (this.busy || !RevisionIdSchema.safeParse(classId).success) return Promise.resolve();
    if (classId === this.state.classId) return Promise.resolve();
    if (this.state.dirty) {
      this.update({ pendingClassId: classId });
      return Promise.resolve();
    }
    return this.select(classId);
  }

  public confirmClassSwitch(discard: boolean): Promise<void> {
    if (this.busy) return Promise.resolve();
    const target = this.state.pendingClassId;
    if (target === null) return Promise.resolve();
    if (!discard) {
      this.update({ pendingClassId: null });
      return Promise.resolve();
    }
    return this.select(target);
  }

  public edit(settings: TeachingSettings): void {
    const { busy, recovery, problem, draft, pendingClassId } = this.state;
    if (
      busy ||
      draft === null ||
      pendingClassId !== null ||
      recovery !== null ||
      problem === "conflict" ||
      problem === "uncertain"
    ) {
      return;
    }
    const baseline = this.state.configuration?.settings ?? DEFAULT_SETTINGS;
    this.update({
      draft: settings,
      dirty: !sameSettings(baseline, settings),
      problem: problem === "invalid" ? null : problem,
    });
  }

  public save(): Promise<void> {
    return this.perform(async () => {
      const { classId, draft, configuration, operatorReady, problem, recovery, pendingClassId } =
        this.state;
      if (
        classId === null ||
        draft === null ||
        !operatorReady ||
        recovery !== null ||
        pendingClassId !== null ||
        problem === "conflict" ||
        problem === "uncertain"
      ) {
        return;
      }
      const parsed = TeachingSettingsSchema.safeParse(draft);
      if (!parsed.success) {
        this.update({ problem: "invalid" });
        return;
      }
      const saved = await this.client.save(
        classId,
        configuration?.version ?? null,
        parsed.data,
        this.abort.signal,
      );
      this.update({
        configuration: saved.configuration,
        draft: saved.configuration.settings,
        dirty: false,
        problem: null,
        recovery: null,
        operatorReady: true,
      });
    });
  }

  public reload(): Promise<void> {
    return this.perform(async () => {
      const { classId, dirty, problem } = this.state;
      if (classId === null) return;
      const requiresRecovery = dirty || problem === "conflict" || problem === "uncertain";
      const read = await this.client.read(classId, this.abort.signal);
      const skills = await this.loadCatalog(classId);
      if (requiresRecovery) {
        this.update({ recovery: read, operatorReady: read.operatorReady, catalog: skills });
      } else {
        this.adopt(read, skills);
      }
    });
  }

  public acceptReload(): void {
    if (this.busy || this.state.pendingClassId !== null) return;
    const recovery = this.state.recovery;
    if (recovery === null) return;
    this.adopt(recovery, this.state.catalog);
  }

  private select(classId: string): Promise<void> {
    return this.perform(async () => {
      this.update({
        classId,
        catalog: [],
        configuration: null,
        operatorReady: false,
        draft: null,
        dirty: false,
        problem: null,
        recovery: null,
        pendingClassId: null,
      });
      const read = await this.client.read(classId, this.abort.signal);
      this.adopt(read, await this.loadCatalog(classId));
    });
  }

  private async loadCatalog(classId: string): Promise<readonly TeachingCatalogEntry[]> {
    const skills: TeachingCatalogEntry[] = [];
    const seen = new Set<string>();
    let cursor = "";
    for (;;) {
      this.abort.signal.throwIfAborted();
      const page = await this.client.catalog(classId, cursor || null, this.abort.signal);
      for (const skill of page.skills) {
        if (!seen.has(skill.id)) {
          seen.add(skill.id);
          skills.push(skill);
        }
      }
      if (page.nextAfterSkillId === null) break;
      if (page.nextAfterSkillId <= cursor) throw new Error();
      cursor = page.nextAfterSkillId;
    }
    return skills;
  }

  private adopt(
    read: TeachingConfigurationResponse,
    skills: readonly TeachingCatalogEntry[],
  ): void {
    this.update({
      configuration: read.configuration,
      operatorReady: read.operatorReady,
      draft: read.configuration?.settings ?? DEFAULT_SETTINGS,
      dirty: false,
      problem: null,
      recovery: null,
      catalog: skills,
    });
  }

  private async perform(operation: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.update({ busy: true });
    try {
      await operation();
    } catch (error) {
      const problem = this.state.problem;
      if (problem !== "conflict" && problem !== "uncertain") {
        this.update({ problem: problemOf(error as TeachingClientFailure) });
      }
    } finally {
      this.busy = false;
      this.update({ busy: false });
    }
  }

  private update(patch: Partial<TeachingState>): void {
    if (this.disposed) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    this.changed(this.state);
  }
}

function sameSettings(a: TeachingSettings, b: TeachingSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const TEACHING_PROBLEMS: ReadonlySet<TeachingProblem> = new Set([
  "invalid",
  "forbidden",
  "conflict",
  "uncertain",
  "unconfigured",
  "skill-unavailable",
]);

function problemOf(error: TeachingClientFailure): TeachingProblem {
  return TEACHING_PROBLEMS.has(error.code) ? error.code : "load";
}
