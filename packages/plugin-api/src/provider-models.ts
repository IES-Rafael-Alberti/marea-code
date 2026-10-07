import * as z from "zod";

/** Prices use integer accounting units; provider-specific raw responses stay in the plugin. */
export const ProviderModelSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(512),
    pricing: z
      .object({
        costUnit: z.string().min(1).max(64),
        inputCostUnitsPerToken: z.number().int().nonnegative(),
        outputCostUnitsPerToken: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const ProviderModelListSchema = z.array(ProviderModelSchema).max(5000);
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
