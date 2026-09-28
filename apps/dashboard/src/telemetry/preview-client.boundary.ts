import {
  MAX_TELEMETRY_PREVIEW_BYTES,
  TELEMETRY_PREVIEW_PATH,
  TelemetryPreviewRequestSchema,
  TelemetryPreviewResponseSchema,
  type TelemetryPreviewPort,
} from "@marea/protocol";
import { dashboardPost } from "../dashboard-post.js";
import { readBoundedJson } from "../bounded-json.boundary.js";
import type { DashboardFetch } from "../modules/active-runs/active-runs-client.boundary.js";

export class PreviewRequestError extends Error {
  constructor(readonly status: number) {
    super("Telemetry preview unavailable.");
  }
}

export function createPreviewClient(fetchRequest: DashboardFetch): TelemetryPreviewPort {
  return {
    async preview(request, signal) {
      const body = TelemetryPreviewRequestSchema.parse(request);
      const response = await fetchRequest(TELEMETRY_PREVIEW_PATH, dashboardPost(body, signal));
      if (!response.ok) throw new PreviewRequestError(response.status);
      if (response.body === null) throw new Error("Missing telemetry preview.");
      const result = TelemetryPreviewResponseSchema.parse(
        await readBoundedJson(response.body, MAX_TELEMETRY_PREVIEW_BYTES),
      );
      if (result.requestId !== request.requestId) throw new Error("Telemetry preview mismatch.");
      return result;
    },
  };
}
