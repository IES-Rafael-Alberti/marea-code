export interface CloseAbandonedRunsInput {
  readonly createEventId: () => string;
  /** Runs whose last activity predates this instant have had no connection. */
  readonly idleBefore: string;
  readonly now: string;
  /** Runs opened at or before this instant have outlived the sign-in session cap. */
  readonly sessionOpenedBefore: string;
}

export interface CloseTeacherRunsInput {
  /** The class every listed run must belong to, or null to authorize each run's own class. */
  readonly classId: string | null;
  readonly closedAt: string;
  readonly createEventId: () => string;
  readonly reason: "teacher-ended" | "class-ended";
  readonly runIds: readonly string[];
  readonly teacherId: string;
}

export interface CloseTeacherRunsResult {
  readonly closed: readonly string[];
  readonly unchanged: readonly string[];
}

export interface RunClosureRepository {
  /** Returns how many runs were closed; each is rechecked inside its closing transaction. */
  closeAbandoned(input: CloseAbandonedRunsInput): number;
  closeRuns(input: CloseTeacherRunsInput): CloseTeacherRunsResult;
}
