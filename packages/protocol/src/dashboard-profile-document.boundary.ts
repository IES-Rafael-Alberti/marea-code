import * as z from "zod";
import {
  MAX_DASHBOARD_PROFILE_REQUEST_BYTES,
  MAX_DASHBOARD_PROFILE_RESPONSE_BYTES,
} from "./dashboard-profiles.js";

/** Transport adapters must also enforce this limit while streaming, before allocating the body. */
export function createDashboardProfileDocumentSchema<Value>(
  schema: z.ZodType<Value>,
  direction: "request" | "response",
) {
  const maximum =
    direction === "request"
      ? MAX_DASHBOARD_PROFILE_REQUEST_BYTES
      : MAX_DASHBOARD_PROFILE_RESPONSE_BYTES;
  return z
    .instanceof(Uint8Array)
    .refine(
      (bytes) => bytes.byteLength <= maximum,
      "Dashboard profile document exceeds byte limit.",
    )
    .transform((bytes, context) => {
      try {
        const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        return schema.parse(input);
      } catch {
        context.addIssue({
          code: "custom",
          message: "Invalid dashboard profile UTF-8 JSON document.",
        });
        return z.NEVER;
      }
    });
}
