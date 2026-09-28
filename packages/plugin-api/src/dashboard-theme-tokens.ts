import * as z from "zod";

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toLowerCase());
const px = z.number().min(0).max(64);
/** Sizes and shadow offsets are CSS pixels; lineHeight is a unitless ratio. */
export const DashboardThemeTokensSchema = z.strictObject({
  schemaVersion: z.literal(1),
  surfaces: z.strictObject({ canvas: color, panel: color, raised: color }),
  text: z.strictObject({ primary: color, secondary: color, inverse: color }),
  borders: z.strictObject({ default: color, strong: color }),
  actions: z.strictObject({ background: color, foreground: color, hover: color, disabled: color }),
  states: z.strictObject({ success: color, warning: color, error: color, info: color }),
  focus: z.strictObject({ color, width: z.number().min(2).max(8), offset: px }),
  typography: z.strictObject({
    fontFamily: z.enum(["system-sans", "system-serif", "system-mono"]),
    fontSize: z.number().min(12).max(24),
    lineHeight: z.number().min(1.2).max(2),
  }),
  spacing: z.strictObject({ small: px, medium: px, large: px }),
  radius: z.strictObject({ small: px, large: px }),
  shadow: z.strictObject({
    color,
    x: z.number().min(-64).max(64),
    y: z.number().min(-64).max(64),
    blur: px,
    spread: px,
  }),
  chartSeries: z
    .array(color)
    .min(6)
    .max(12)
    .refine((values) => new Set(values).size === values.length),
});
export type DashboardThemeTokens = z.infer<typeof DashboardThemeTokensSchema>;
