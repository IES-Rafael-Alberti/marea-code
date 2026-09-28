import {
  MAX_REVIEWED_EVIDENCE_RESPONSE_BYTES,
  REVIEWED_EVIDENCE_PATH,
  ReviewedEvidenceQuerySchema,
  ReviewedEvidenceResponseSchema,
  type ReviewedEvidencePort,
} from "@marea/protocol";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { createProjectionPost } from "../usage-health-client.boundary.js";

export function createReviewedEvidenceClient(fetchRequest: DashboardFetch): ReviewedEvidencePort {
  const post = createProjectionPost(fetchRequest, MAX_REVIEWED_EVIDENCE_RESPONSE_BYTES);
  return {
    async read(input, signal) {
      const query = ReviewedEvidenceQuerySchema.parse(input);
      const response = await post(
        `${REVIEWED_EVIDENCE_PATH}${query.kind}`,
        query,
        {
          parse(value: unknown) {
            const parsed = ReviewedEvidenceResponseSchema.parse(value);
            return { ...parsed, requestId: parsed.query.requestId, classId: parsed.query.classId };
          },
        },
        signal,
      );
      if (JSON.stringify(response.query) !== JSON.stringify(query))
        throw new Error("Evidence context mismatch.");
      return ReviewedEvidenceResponseSchema.parse({
        kind: response.kind,
        query: response.query,
        entries: response.entries,
        next: response.next,
      });
    },
  };
}
