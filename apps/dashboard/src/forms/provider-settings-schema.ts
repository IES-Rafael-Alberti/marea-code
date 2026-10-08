import * as z from "zod";
import { ProviderSettingsDescriptorSchema } from "@marea/plugin-api";

/** Public settings projection: secret fields reveal presence only. */
export const ProviderSettingsProjectionSchema = z
  .object({
    id: z.string(),
    descriptor: ProviderSettingsDescriptorSchema,
    values: z.record(z.string(), z.string()),
    secrets: z.array(z.string()),
  })
  .strict();
