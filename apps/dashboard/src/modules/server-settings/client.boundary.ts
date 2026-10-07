import * as z from "zod";
import { UsagePolicySchema, PrivateProviderRouteSchema } from "@marea/protocol";
import { ProviderSettingsDescriptorSchema } from "@marea/plugin-api";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
const route = z.object({
  providerId: z.string(),
  model: z.string(),
  inputTokenCeiling: z.number().int().positive(),
  budget: UsagePolicySchema,
});
export const SettingsResponse = z.discriminatedUnion("administrator", [
  z.object({ administrator: z.literal(false), initialized: z.boolean() }).strict(),
  z
    .object({
      administrator: z.literal(true),
      initialized: z.literal(true),
      revision: z.number().int().nonnegative(),
      useCommonRoute: z.boolean(),
      legacyRoutes: z.array(z.object({ classId: z.string(), route: PrivateProviderRouteSchema })),
      route: PrivateProviderRouteSchema.nullable(),
      education: z.object({ map: route.optional(), reports: route.optional() }),
      providers: z.array(
        z.object({
          id: z.string(),
          descriptor: ProviderSettingsDescriptorSchema.nullable(),
          configured: z.boolean(),
          supportsModels: z.boolean().optional(),
          values: z.record(z.string(), z.string()),
          secrets: z.array(z.string()),
        }),
      ),
    })
    .strict(),
]);
export type SettingsResponse = z.infer<typeof SettingsResponse>;
export type EditableSettings = Extract<SettingsResponse, { administrator: true }>;
export async function settingsRequest(
  fetchRequest: DashboardFetch,
  input: object,
  signal: AbortSignal,
) {
  const response = await fetchRequest("/api/v1/dashboard/server-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      response.status === 409 ? "conflict" : response.status === 400 ? "invalid" : "unavailable",
    );
  }
  const text = await response.text();
  if (text.length > 262144) throw new Error("unavailable");
  return SettingsResponse.parse(JSON.parse(text));
}

const SavePayload = SettingsResponse.options[1]
  .pick({ route: true, education: true, useCommonRoute: true })
  .extend({
    operation: z.literal("save"),
    expectedRevision: z.number().int().nonnegative(),
    connections: z.record(z.string(), z.record(z.string(), z.string())),
  });
export async function saveSettings(
  fetchRequest: DashboardFetch,
  input: object,
  signal: AbortSignal,
) {
  if (!SavePayload.safeParse(input).success) return { ok: false as const, reason: "invalid" };
  try {
    return { ok: true as const, value: await settingsRequest(fetchRequest, input, signal) };
  } catch (error: unknown) {
    return {
      ok: false as const,
      reason:
        error instanceof Error && (error.message === "conflict" || error.message === "invalid")
          ? error.message
          : "unavailable",
    };
  }
}
