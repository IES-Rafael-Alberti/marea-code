import * as z from "zod";

const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_COMPATIBILITY_LENGTH = 500;
const MAX_CRITERIA = 64;
const MAX_CRITERION_CODE_LENGTH = 64;
const MAX_CRITERION_TEXT_LENGTH = 1_024;
const CONTROL_CHARACTER = /\p{Cc}/u;

const trimmedText = z.string().trim().min(1);
const criterionCode = trimmedText
  .max(MAX_CRITERION_CODE_LENGTH)
  .refine(withoutControlCharacters, "Control characters are not allowed.");
const criterionStatement = z
  .string()
  .trim()
  .max(MAX_CRITERION_TEXT_LENGTH)
  .refine(withoutControlCharacters, "Control characters are not allowed.");
const criterionLevel = trimmedText
  .max(MAX_CRITERION_TEXT_LENGTH)
  .refine(withoutControlCharacters, "Control characters are not allowed.");
const criterionSchema = z
  .object({
    codigo: criterionCode,
    enunciado: criterionStatement.default(""),
    niveles: z.tuple([criterionLevel, criterionLevel, criterionLevel, criterionLevel]).optional(),
  })
  .strict();

export const SkillFrontmatterSchema = z
  .object({
    name: trimmedText,
    description: trimmedText.max(MAX_DESCRIPTION_LENGTH),
    license: trimmedText.optional(),
    compatibility: trimmedText.max(MAX_COMPATIBILITY_LENGTH).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.unknown().optional(),
    module: trimmedText.optional(),
    criterios: z.array(criterionSchema).max(MAX_CRITERIA).optional(),
  })
  .strict();

function withoutControlCharacters(value: string): boolean {
  return !CONTROL_CHARACTER.test(value);
}
