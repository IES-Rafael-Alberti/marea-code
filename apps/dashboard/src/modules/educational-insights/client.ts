import * as z from "zod";
import {
  CURRENT_PROTOCOL_VERSION,
  EDUCATIONAL_INSIGHTS_PATH,
  InsightsRequestSchema,
  MAX_INSIGHTS_BYTES,
} from "@marea/protocol";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { createProjectionPost } from "../usage-health-client.boundary.js";
const response = z.object({
  requestId: z.string(),
  classId: z.string(),
  kind: z.string(),
  data: z.unknown(),
});
export function insightsClient(fetchRequest: DashboardFetch) {
  const post = createProjectionPost(fetchRequest, MAX_INSIGHTS_BYTES);
  return async <T>(
    classId: string,
    input: object,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    const request = InsightsRequestSchema.parse({
      ...input,
      classId,
      requestId: `insights:${crypto.randomUUID()}`,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
    });
    const result = await post(EDUCATIONAL_INSIGHTS_PATH, request, response, signal);
    if (result.kind !== request.kind) throw new Error("invalid-response");
    return schema.parse(result.data);
  };
}
