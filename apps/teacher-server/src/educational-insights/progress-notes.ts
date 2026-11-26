import { createHash, randomUUID } from "node:crypto";
import { MAX_INSIGHTS_BYTES } from "@marea/protocol";
import type { Clock } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { PrivateProviderRoute } from "../sessions/contracts.js";
import { InsightsFailure } from "./model-output.boundary.js";
import { clearNotesNotice } from "./notes-notice.js";
import { summarizeNotes, summaryRoute, type SummaryInference } from "./notes-summary.js";
import { recentLines } from "./notes-text.js";
import type { LearningProgress } from "./progress.js";

/** The class route a teacher's proposal uses, with the server's common route applied. */
export type ClassRouteLookup = (
  teacherId: string,
  classId: string,
) => PrivateProviderRoute | undefined;

/**
 * The teacher's view of one criterion's notes. `revision` digests the stored text, so a save
 * conflicts only when the notes themselves changed, not when an approval only moved a level.
 */
export class LearningNotes {
  constructor(
    readonly progress: LearningProgress,
    readonly inference: SummaryInference,
    readonly clock: Clock,
    readonly routes: ClassRouteLookup,
  ) {}
  read(classId: string, studentId: string, key: string) {
    const row = this.progress.database.readOne(
      "SELECT memory FROM marea_learning_progress WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
      [classId, studentId, key],
    );
    if (row === undefined) throw new TeacherDomainError("request.conflict");
    const stored = String(row.memory);
    // Reading never fails: a text too long for one response shows its newest lines only.
    const { text, omitted } = recentLines(stored, MAX_INSIGHTS_BYTES / 2);
    return {
      notes: text,
      omitted,
      revision: `sha256:${createHash("sha256").update(stored).digest("hex")}`,
    };
  }
  /** Teacher-owned text replaces the notes; an empty text clears them. */
  save(
    classId: string,
    studentId: string,
    key: string,
    notes: string,
    expectedRevision: string,
    authorize: () => void,
  ) {
    return this.progress.database.transaction(() => {
      authorize();
      const current = this.read(classId, studentId, key);
      if (current.revision !== expectedRevision) return { ...current, conflict: true };
      this.progress.database.execute(
        "UPDATE marea_learning_progress SET memory = ?4, revision = ?5 WHERE class_id = ?1 AND student_id = ?2 AND criterion_key = ?3",
        [classId, studentId, key, notes, randomUUID()],
      );
      clearNotesNotice(this.progress.database, studentId);
      return { ...this.read(classId, studentId, key), conflict: false };
    });
  }
  /** A summary for the teacher to review; nothing is saved and failures are closed codes. */
  async propose(teacherId: string, classId: string, studentId: string, key: string) {
    const { notes } = this.read(classId, studentId, key);
    if (notes.trim() === "") return { proposal: null, failure: "empty" };
    try {
      const route = this.routes(teacherId, classId);
      if (route === undefined) throw new InsightsFailure("unconfigured");
      const proposal = await summarizeNotes(
        this.inference,
        summaryRoute(route, route.evaluation ?? route),
        `notes-proposal:${classId}:${this.clock.now().slice(0, 10)}`,
        "teacher",
        notes,
        AbortSignal.timeout(120_000),
      );
      return { proposal, failure: null };
    } catch (error) {
      return {
        proposal: null,
        failure: error instanceof InsightsFailure ? error.code : "provider",
      };
    }
  }
}
