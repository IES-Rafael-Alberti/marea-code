import * as z from "zod";

const Label = z
  .object({
    es: z.string().min(1).max(200),
    en: z.string().min(1).max(200),
    eu: z.string().min(1).max(200),
  })
  .strict();
export const ProviderSettingsDescriptorSchema = z
  .object({
    version: z.literal(1),
    name: Label,
    fields: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u),
            label: Label,
            kind: z.enum(["text", "secret", "url"]),
            required: z.boolean(),
            multiline: z.boolean().optional(),
            defaultValue: z.string().max(2048).optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.fields.map((field) => field.key);
    if (
      new Set(keys).size !== keys.length ||
      value.fields.some((field) => field.kind === "secret" && field.defaultValue !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate fields or secret defaults are not permitted",
      });
  });
export type ProviderSettingsDescriptor = z.infer<typeof ProviderSettingsDescriptorSchema>;
