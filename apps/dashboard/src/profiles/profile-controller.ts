import type { DashboardProfileScope } from "@marea/protocol";
import type {
  AuthorizedCatalog,
  ProfileCatalog,
  ProfileState,
  ProfileValue,
} from "./profile-catalog.js";
import {
  ProfileCatalogMismatchError,
  LegacyProfileModeError,
  ProfileRequestError,
  type ProfileClient,
} from "./profile-client.boundary.js";

export type ProfileProblem =
  "unavailable" | "conflict" | "uncertain" | "catalog" | "recovery" | "invalid" | null;
export class ProfileController {
  scope: DashboardProfileScope = { kind: "teacher" };
  current: ProfileState | null = null;
  catalog: AuthorizedCatalog | null = null;
  draft: ProfileValue | null = null;
  recovery: ProfileState | null = null;
  problem: ProfileProblem = null;
  legacy = false;
  busy = false;
  dirty = false;
  matched = false;
  discardUnavailable = false;
  private request = new AbortController();
  private readonly drafts = new Map<string, ProfileValue | null>();
  constructor(
    private readonly client: ProfileClient,
    readonly release: ProfileCatalog,
    private readonly changed: () => void,
  ) {}

  async select(scope: DashboardProfileScope): Promise<void> {
    if (this.dirty) this.drafts.set(JSON.stringify(this.scope), this.draft);
    this.request.abort();
    this.request = new AbortController();
    this.scope = scope;
    this.current = null;
    this.catalog = null;
    this.recovery = null;
    this.draft = this.drafts.get(JSON.stringify(scope)) ?? null;
    this.dirty = this.draft !== null;
    this.problem = null;
    this.legacy = false;
    this.discardUnavailable = false;
    this.busy = false;
    await this.read();
  }
  async read(): Promise<void> {
    if (this.busy || this.request.signal.aborted) return;
    const signal = this.request.signal;
    this.busy = true;
    this.changed();
    try {
      const [current, catalog] = await Promise.all([
        this.client.read(this.scope, signal),
        this.client.catalog(this.scope, signal),
      ]);
      if (signal.aborted) return;
      this.legacy = false;
      this.catalog = catalog;
      if (
        current.catalogRevision !== this.release.revision ||
        catalog.catalogRevision !== this.release.revision
      ) {
        this.problem = "catalog";
        return;
      }
      if (this.dirty || this.problem === "uncertain" || this.problem === "conflict") {
        this.recovery = current;
        this.matched = JSON.stringify(this.value(current)) === JSON.stringify(this.draft);
      } else {
        this.accept(current);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.legacy = error instanceof LegacyProfileModeError;
        this.problem = error instanceof ProfileCatalogMismatchError ? "catalog" : "unavailable";
      }
    } finally {
      if (!signal.aborted) {
        this.busy = false;
        this.changed();
      }
    }
  }
  edit(value: ProfileValue): void {
    if (this.busy || this.request.signal.aborted) return;
    this.draft = value;
    if (this.problem === "invalid") this.problem = null;
    this.dirty = true;
    this.changed();
  }
  reconcile(keepDraft: boolean): void {
    if (this.recovery === null || this.problem === "catalog") return;
    const draft = this.draft;
    this.accept(this.recovery);
    if (keepDraft && draft !== null) this.edit(draft);
    this.changed();
  }
  async write(reset = false): Promise<void> {
    if (this.blocked()) return;
    if (this.current === null) return;
    if (!this.canWrite(reset)) return;
    const current = this.current;
    const record = current.override ?? current.personal;
    const write = {
      scope: this.scope,
      expectedRevision: record.revision,
      expectedPersonalRevision: current.personal.revision,
      catalogRevision: this.release.revision,
    };
    const value =
      this.scope.kind === "teacher"
        ? this.release.schemas.personalValue.safeParse(this.draft)
        : this.release.schemas.classValue.safeParse(this.draft);
    if (!(reset || value.success)) {
      this.problem = "invalid";
      this.changed();
      return;
    }
    const signal = this.request.signal;
    this.busy = true;
    this.changed();
    try {
      const result = reset
        ? await this.client.reset(write, signal)
        : await this.client.save(
            write,
            this.release.schemas.classValue.parse(value.data),
            this.discardUnavailable,
            signal,
          );
      this.acceptWrite(result, signal);
    } catch (error) {
      if (!signal.aborted)
        this.problem =
          error instanceof ProfileCatalogMismatchError
            ? "catalog"
            : error instanceof ProfileRequestError && error.status === 409
              ? "conflict"
              : "uncertain";
    } finally {
      if (!signal.aborted) {
        this.busy = false;
        this.changed();
      }
    }
    if (this.problem === "uncertain" || this.problem === "conflict") await this.read();
  }
  private canWrite(reset: boolean): boolean {
    return this.problem === null || (reset && this.problem === "recovery");
  }
  private acceptWrite(result: ProfileState, signal: AbortSignal): void {
    if (signal.aborted) return;
    if (result.catalogRevision !== this.release.revision) this.problem = "catalog";
    else this.accept(result);
  }
  private blocked(): boolean {
    return this.busy || this.catalog === null || this.request.signal.aborted;
  }
  dispose(): void {
    this.request.abort();
    this.drafts.clear();
    this.draft = null;
    this.dirty = false;
  }
  private value(state: ProfileState): ProfileValue | null {
    return state.override === null ? state.personal.value : state.override.value;
  }
  private accept(state: ProfileState): void {
    this.current = state;
    this.recovery = null;
    this.draft =
      this.value(state) ??
      (this.scope.kind === "teacher" ? (this.catalog?.releaseDefaults ?? state.effective) : {});
    this.dirty = false;
    this.drafts.delete(JSON.stringify(this.scope));
    this.discardUnavailable = false;
    const record = state.override ?? state.personal;
    this.problem = record.status === "recovery-required" ? "recovery" : null;
  }
}
