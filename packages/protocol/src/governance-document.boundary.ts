import * as z from "zod";
import { MAX_TEACHING_CONFIGURATION_BYTES } from "./teaching-configuration.js";

export function boundedGovernanceDocument<T extends { readonly kind: string }>(
  schema: z.ZodType<T>,
  limit: (kind: T["kind"]) => number,
) {
  return z.instanceof(Uint8Array).transform((bytes, context) => {
    if (bytes.byteLength > MAX_TEACHING_CONFIGURATION_BYTES) {
      context.addIssue({ code: "custom", message: "Document exceeds byte limit." });
      return z.NEVER;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      context.addIssue({ code: "custom", message: "Invalid UTF-8 JSON document." });
      return z.NEVER;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "Invalid governance document." });
      return z.NEVER;
    }
    if (bytes.byteLength > limit(parsed.data.kind)) {
      context.addIssue({ code: "custom", message: "Document exceeds byte limit." });
      return z.NEVER;
    }
    return parsed.data;
  });
}
