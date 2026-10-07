import * as z from "zod";
import { RunIdSchema } from "./identifiers.js";
import { RevisionIdSchema } from "./technical.js";
import { UtcTimestampSchema } from "./runs.js";
const FilterTime = UtcTimestampSchema.transform((value) => new Date(value).toISOString());

/** Additive dashboard endpoint; existing history pages keep their baseline shape. */
export const SessionExportQuerySchema = z
  .object({
    runId: RunIdSchema.optional(),
    classId: RevisionIdSchema.optional(),
    studentId: RevisionIdSchema.optional(),
    from: FilterTime.optional(),
    until: FilterTime.optional(),
    identities: z.enum(["names", "pseudonyms"]),
  })
  .strict()
  .refine(
    (q) => q.from === undefined || q.until === undefined || q.from < q.until,
    "The exclusive end must follow the start.",
  );

export type SessionExportQuery = z.infer<typeof SessionExportQuerySchema>;
