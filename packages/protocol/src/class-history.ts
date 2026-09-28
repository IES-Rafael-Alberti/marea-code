import * as z from "zod";
import { RequestIdSchema, RunIdSchema } from "./identifiers.js";
import { RevisionIdSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";
import { SessionHistoryItemSchema } from "./history.js";
/** Dashboard-only projection; the existing student history wire shape stays unchanged. */
export const ClassSessionItemSchema = SessionHistoryItemSchema.unwrap()
  .extend({ classId: RevisionIdSchema })
  .strict()
  .readonly();
export const ClassSessionsResponseSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    kind: z.literal("class-sessions-response"),
    runs: z.array(ClassSessionItemSchema).max(50).readonly(),
    nextBeforeRunId: RunIdSchema.nullable(),
  })
  .strict()
  .readonly();
export type ClassSessionItem = z.infer<typeof ClassSessionItemSchema>;
export type ClassSessionsResponse = z.infer<typeof ClassSessionsResponseSchema>;
