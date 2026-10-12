import * as z from "zod";

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}]+$/u);
/** Module codes are text so identifiers such as 0485 retain their leading zero. */
export const SkillModuleSchema = z
  .strictObject({
    codigo: text(64).optional(),
    nombre: text(256).optional(),
  })
  .refine(
    (value) => value.codigo !== undefined || value.nombre !== undefined,
    "Supply a module code, name, or both.",
  );
export const SkillCurricularReferenceSchema = z.strictObject({
  modulo: SkillModuleSchema,
  ra: z.number().int().min(1).max(999),
  criterio: text(64),
});
export const SkillCurriculumSchema = z.strictObject({
  modulos: z.array(SkillModuleSchema).min(1).max(32),
  fuente: text(2048).optional(),
});
export const SkillCurriculumSummarySchema = z.strictObject({
  modulos: z.array(SkillModuleSchema).max(1056),
  referencias: z.array(SkillCurricularReferenceSchema).max(1024),
});
export type SkillCurriculumSummary = z.infer<typeof SkillCurriculumSummarySchema>;
