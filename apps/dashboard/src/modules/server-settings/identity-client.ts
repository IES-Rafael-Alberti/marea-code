import * as z from "zod";
import { ProviderSettingsProjectionSchema } from "../../forms/provider-settings-schema.js";
import { ProviderSettingsDescriptorSchema } from "@marea/plugin-api";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";

export const IdentitySettingsResponse = z
  .object({
    revision: z.number().int().nonnegative(),
    restart: z.boolean(),
    providers: z.array(ProviderSettingsProjectionSchema.extend({ configured: z.boolean() })),
  })
  .strict();
export const IdentityStatusResponse = z
  .object({
    providers: z.array(
      z
        .object({
          id: z.string(),
          guides: ProviderSettingsDescriptorSchema.shape.guides.unwrap(),
          kinds: z.array(z.object({ kind: z.string(), ready: z.boolean() }).strict()),
        })
        .strict(),
    ),
  })
  .strict();

export async function identityRequest<T>(
  fetchRequest: DashboardFetch,
  body: object,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetchRequest("/api/v1/dashboard/server-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(response.status === 409 ? "conflict" : "unavailable");
  const text = await response.text();
  if (text.length > 262144) throw new Error("invalid-response");
  return schema.parse(JSON.parse(text));
}
