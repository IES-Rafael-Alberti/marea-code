import * as z from "zod";
import { RequestIdSchema } from "./identifiers.js";
import { CurrentProtocolVersionSchema } from "./version.js";

/** A separate teacher endpoint keeps the existing strict profile and student contracts intact. */
export const DashboardLanguagePreferenceSchema = z.enum(["automatic", "es", "en", "eu"]);
const envelope = { protocolVersion: CurrentProtocolVersionSchema, requestId: RequestIdSchema };
export const DashboardLanguageRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("read") }),
  z.strictObject({
    ...envelope,
    kind: z.literal("save"),
    preference: DashboardLanguagePreferenceSchema,
  }),
]);
export const DashboardLanguageResponseSchema = z.strictObject({
  ...envelope,
  preference: DashboardLanguagePreferenceSchema.nullable(),
});
