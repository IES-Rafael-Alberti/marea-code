import * as z from "zod";

export const DashboardPlacementSchema = z.strictObject({
  slot: z.enum(["main", "aside"]),
  size: z.enum(["compact", "standard", "wide"]),
});
export type DashboardPlacement = z.infer<typeof DashboardPlacementSchema>;
export const DashboardPermissionSchema = z.enum([
  "class-read",
  "session-read",
  "evaluation-read",
  "evaluation-review",
  "usage-read",
  "health-read",
]);
export const DashboardFreshnessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("on-demand") }),
  z.strictObject({
    kind: z.literal("poll"),
    intervalMs: z.number().int().min(1000).max(3_600_000),
  }),
  z.strictObject({
    kind: z.literal("live"),
    reconnectMs: z.number().int().min(1000).max(60_000),
    fallbackIntervalMs: z.number().int().min(1000).max(3_600_000),
  }),
]);
export const DashboardCapabilitySchema = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9.-]*\/v[1-9][0-9]*$/);
export function dashboardDescriptorShape() {
  return {
    requiredServerCapabilities: z.array(DashboardCapabilitySchema).max(32).refine(unique),
    requiredPermissions: z.array(DashboardPermissionSchema).max(6).refine(unique),
    supportedPlacements: z
      .array(DashboardPlacementSchema)
      .min(1)
      .max(6)
      .refine((values) => unique(values.map((value) => `${value.slot}:${value.size}`))),
    defaultPlacement: DashboardPlacementSchema,
    defaultEnabled: z.boolean(),
    freshness: DashboardFreshnessSchema,
  };
}
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
export function supportsDefault(value: {
  readonly supportedPlacements: readonly DashboardPlacement[];
  readonly defaultPlacement: DashboardPlacement;
}): boolean {
  return value.supportedPlacements.some(
    (placement) =>
      placement.slot === value.defaultPlacement.slot &&
      placement.size === value.defaultPlacement.size,
  );
}
