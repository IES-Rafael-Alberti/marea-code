import * as z from "zod";
export const ObservabilityConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    pluginId: z.string().min(1).max(128),
    values: z.record(z.string().max(64), z.string().max(2048)),
    namespace: z.uuid(),
    epoch: z.uuid(),
  })
  .strict();
export type ObservabilityConfiguration = z.infer<typeof ObservabilityConfigurationSchema>;
