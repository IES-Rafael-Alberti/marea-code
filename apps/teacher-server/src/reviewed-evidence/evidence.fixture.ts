import { ReviewedEvidenceQuerySchema, ReviewedCriterionKeySchema } from "@marea/protocol";
import {
  evaluationFixture,
  EVALUATION_DRAFT,
  NOW,
  teacher,
  reviewRequest,
} from "../../test-support/evaluation-fixture.js";
import { teachingConfiguration } from "../../test-support/teaching-fixture.js";
import { SqliteReviewedEvidenceRepository } from "../platform/persistence/sqlite-reviewed-evidence-repository.js";
import { ReviewedEvidenceService } from "./service.js";

export { NOW, teacher };
export const evidenceQuery = (extra: object = {}) =>
  ReviewedEvidenceQuerySchema.parse({
    protocolVersion: "0.1",
    requestId: "evidence:test",
    classId: "class:one",
    kind: "students",
    ...extra,
  });
export function evidenceFixture() {
  const f = evaluationFixture();
  const content = teachingConfiguration().content;
  const skill = content.didacticSkills[0];
  if (skill === undefined) throw new Error("Missing synthetic skill.");
  const codes = ["boundary", "failure"];
  f.database.execute("UPDATE marea_run_teaching_snapshots SET teaching_json = ?1", [
    JSON.stringify({
      ...content,
      didacticSkills: [
        {
          ...skill,
          criteria: codes.map((code) => ({ code, statement: `Frozen ${code}`, levels: null })),
        },
      ],
    }),
  ]);
  const draft = {
    ...EVALUATION_DRAFT,
    criteria: codes.map((code) => ({
      skillId: skill.id,
      code,
      result: "passed" as const,
      confidence: "high" as const,
      evidence: `Reviewed ${code}`,
    })),
  };
  f.queue();
  const claim = f.repository.claim("worker:evidence", NOW);
  if (claim === null) throw new Error("Missing synthetic claim.");
  f.repository.finish(claim, draft, NOW);
  const approve = () =>
    f.repository.approve({
      identity: teacher,
      request: { ...reviewRequest(), draft },
      noticeId: "notice:evidence",
      now: NOW,
    });
  const repository = new SqliteReviewedEvidenceRepository(f.database);
  return {
    ...f,
    approve,
    draft,
    repository,
    service: new ReviewedEvidenceService(repository),
    criterion: ReviewedCriterionKeySchema.parse({
      skillId: skill.id,
      digest: skill.digest,
      code: "boundary",
    }),
  };
}
