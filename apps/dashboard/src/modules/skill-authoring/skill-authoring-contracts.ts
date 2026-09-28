import type {
  SkillAuthoringCopyResponse,
  SkillAuthoringDraft,
  SkillAuthoringReadResponse,
  SkillAuthoringSaveResponse,
  SkillAuthoringValidateResponse,
  TeachingCatalogEntry,
  TeachingCatalogResponse,
  TeachingClassSummary,
  TeachingClassesResponse,
} from "@marea/protocol";

import type { DashboardLocale } from "../../messages.js";

/** Transport generates and correlates request IDs; caller supplies no operator fields. */
export interface SkillAuthoringClient {
  classes(afterClassId: string | null, signal: AbortSignal): Promise<TeachingClassesResponse>;
  catalog(
    classId: string,
    afterSkillId: string | null,
    signal: AbortSignal,
  ): Promise<TeachingCatalogResponse>;
  /** Personal reads address the current teacher by slug; no owner ID is sent. */
  readPersonal(
    classId: string,
    slug: string,
    signal: AbortSignal,
  ): Promise<SkillAuthoringReadResponse>;
  readCatalog(
    classId: string,
    skillId: string,
    signal: AbortSignal,
  ): Promise<SkillAuthoringReadResponse>;
  validate(
    classId: string,
    draft: SkillAuthoringDraft,
    signal: AbortSignal,
  ): Promise<SkillAuthoringValidateResponse>;
  save(
    classId: string,
    draft: SkillAuthoringDraft,
    expectedDigest: string | null,
    signal: AbortSignal,
  ): Promise<SkillAuthoringSaveResponse>;
  copy(
    classId: string,
    sourceSkillId: string,
    sourceDigest: string,
    slug: string,
    signal: AbortSignal,
  ): Promise<SkillAuthoringCopyResponse>;
}

export type SkillAuthoringProblem =
  "load" | "invalid" | "forbidden" | "conflict" | "uncertain" | "skill-unavailable";

/** A failed/uncertain write keeps its draft; the client must not resend automatically. */
export interface SkillAuthoringClientFailure extends Error {
  readonly code: SkillAuthoringProblem;
}

export type SkillAuthoringNavigationTarget =
  | { readonly kind: "class"; readonly classId: string }
  | { readonly kind: "skill"; readonly classId: string; readonly skillId: string }
  | { readonly kind: "personal"; readonly classId: string; readonly slug: string };

export interface SkillAuthoringState {
  readonly busy: boolean;
  readonly classes: readonly TeachingClassSummary[];
  readonly classesLoaded: boolean;
  readonly classId: string | null;
  readonly catalog: readonly TeachingCatalogEntry[];
  readonly catalogLoaded: boolean;
  readonly selectedSkillId: string | null;
  readonly personalSlug: string | null;
  readonly loadedBundle: NonNullable<SkillAuthoringReadResponse["skill"]> | null;
  readonly editable: boolean;
  readonly draft: SkillAuthoringDraft | null;
  readonly dirty: boolean;
  readonly validation: SkillAuthoringValidateResponse | null;
  readonly problem: SkillAuthoringProblem | null;
  /** Set by reload while retaining a conflicting/uncertain draft until explicit acceptance. */
  readonly recovery: SkillAuthoringReadResponse | null;
  /** Dirty switches are staged until the user confirms or cancels. */
  readonly pendingTarget: SkillAuthoringNavigationTarget | null;
}

export interface SkillAuthoringActions {
  loadClasses(): Promise<void>;
  selectClass(classId: string): Promise<void>;
  loadCatalog(classId: string): Promise<void>;
  selectSkill(skillId: string): Promise<void>;
  /**
   * Personal read by slug; a missing skill starts an empty editable draft.
   * Like class/catalog navigation, a dirty switch stages a personal target
   * without changing the current selection or draft until confirmation.
   */
  startPersonalDraft(slug: string): Promise<void>;
  editDraft(draft: SkillAuthoringDraft): void;
  validateDraft(): Promise<void>;
  saveDraft(expectedDigest: string | null): Promise<void>;
  copySkill(sourceSkillId: string, sourceDigest: string, slug: string): Promise<void>;
  /**
   * False cancels only the pending destination, preserving selection and draft.
   * True discards current edits and opens the staged class, catalog or personal target.
   */
  confirmNavigation(discard: boolean): Promise<void>;
  /** Reads current personal state, preserving a dirty/conflicting/uncertain draft. */
  reload(): Promise<void>;
  /** Explicitly adopts readback; the user can then reapply edits deliberately. */
  acceptReadback(): void;
}

export interface SkillAuthoringModuleProperties {
  readonly locale: DashboardLocale;
  readonly state: SkillAuthoringState;
  readonly controller: SkillAuthoringActions;
}
