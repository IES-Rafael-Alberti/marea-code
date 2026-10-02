import type {
  SaveTeachingConfigurationResponse,
  TeachingCatalogEntry,
  TeachingCatalogResponse,
  TeachingClassesResponse,
  TeachingClassSummary,
  TeachingConfiguration,
  TeachingConfigurationResponse,
  TeachingSettings,
} from "@marea/protocol";

import type { DashboardLocale } from "../../messages.js";

/** Transport generates and correlates request IDs; caller supplies no operator fields. */
export interface TeachingClient {
  classes(afterClassId: string | null, signal: AbortSignal): Promise<TeachingClassesResponse>;
  read(classId: string, signal: AbortSignal): Promise<TeachingConfigurationResponse>;
  catalog(
    classId: string,
    afterSkillId: string | null,
    signal: AbortSignal,
  ): Promise<TeachingCatalogResponse>;
  save(
    classId: string,
    expectedVersion: string | null,
    settings: TeachingSettings,
    signal: AbortSignal,
  ): Promise<SaveTeachingConfigurationResponse>;
}

export type TeachingProblem =
  | "load"
  | "invalid"
  | "forbidden"
  | "conflict"
  | "uncertain"
  | "unconfigured"
  | "skill-unavailable";

/** A failed/invalid save response is uncertain unless HTTP conclusively rejected the write. */
export interface TeachingClientFailure extends Error {
  readonly code: TeachingProblem;
}

export interface TeachingState {
  readonly busy: boolean;
  readonly classes: readonly TeachingClassSummary[];
  readonly classesLoaded: boolean;
  readonly classId: string | null;
  readonly catalog: readonly TeachingCatalogEntry[];
  readonly configuration: TeachingConfiguration | null;
  readonly operatorReady: boolean;
  readonly draft: TeachingSettings | null;
  readonly dirty: boolean;
  readonly problem: TeachingProblem | null;
  /** Set by reload while retaining draft. No save until the user accepts this readback. */
  readonly recovery: TeachingConfigurationResponse | null;
  /** Dirty class switches are staged until the user confirms or cancels. */
  readonly pendingClassId: string | null;
}

export interface TeachingActions {
  loadClasses(): Promise<void>;
  selectClass(classId: string): Promise<void>;
  confirmClassSwitch(discard: boolean): Promise<void>;
  edit(settings: TeachingSettings): void;
  save(): Promise<void>;
  /** Reads current settings, preserving a dirty/conflicting/uncertain draft in state. */
  reload(): Promise<void>;
  /** Explicitly replaces the draft with readback; user can then manually reapply edits. */
  acceptReload(): void;
}

export interface TeachingModuleProperties {
  readonly classSelection?: boolean;
  readonly locale: DashboardLocale;
  readonly state: TeachingState;
  readonly controller: TeachingActions;
}
