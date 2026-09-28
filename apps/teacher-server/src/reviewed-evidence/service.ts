import {
  ReviewedEvidenceQuerySchema,
  ReviewedEvidenceResponseSchema,
  type ReviewedEvidenceQuery,
  type ReviewedEvidenceResponse,
} from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";

export interface ReviewedEvidenceRepository {
  transaction<T>(read: () => T): T;
  requireTeacherClass(teacherId: string, classId: string): void;
  read(query: ReviewedEvidenceQuery): ReviewedEvidenceResponse;
}

/** Authorization and read share a transaction; visibility never grants access. */
export class ReviewedEvidenceService {
  constructor(private readonly repository: ReviewedEvidenceRepository) {}
  read(identity: AuthenticatedIdentity, input: ReviewedEvidenceQuery): ReviewedEvidenceResponse {
    const query = ReviewedEvidenceQuerySchema.parse(input);
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    return this.repository.transaction(() => {
      this.repository.requireTeacherClass(identity.userId, query.classId);
      return ReviewedEvidenceResponseSchema.parse(this.repository.read(query));
    });
  }
}
