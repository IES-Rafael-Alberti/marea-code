import * as z from "zod";
import { ProviderSettingsProjectionSchema } from "../../forms/provider-settings-schema.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { authenticatedJsonRequest } from "../evaluation/authenticated-json.boundary.js";

export const ObservabilityResponse = z
  .object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    pluginId: z.string().nullable(),
    status: z
      .object({
        pending: z.number(),
        failed: z.number(),
        sent: z.number(),
        dropped: z.number(),
        lastSentAt: z.string().nullable(),
        healthy: z.boolean(),
        available: z.boolean(),
      })
      .strict(),
    plugins: z.array(ProviderSettingsProjectionSchema),
  })
  .strict();
export type ObservabilityState = z.infer<typeof ObservabilityResponse>;
export async function observabilityRequest(
  fetchRequest: DashboardFetch,
  body: object,
  signal: AbortSignal,
) {
  return authenticatedJsonRequest(fetchRequest, "/api/v1/dashboard/observability", body, signal);
}
