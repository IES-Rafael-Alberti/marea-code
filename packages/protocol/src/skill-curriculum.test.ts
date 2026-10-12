import { expect, it } from "vitest";
import {
  SkillModuleSchema,
  SkillCurriculumSchema,
  SkillCurriculumSummarySchema,
  SkillCurricularReferenceSchema,
} from "./skill-curriculum.js";
import { SkillWorkspaceRequestSchema } from "./skill-workspace.js";
import { SkillFrontmatterSchema } from "./skill-markdown.js";
const modulo = { codigo: "0485", nombre: "Programación" };
const reference = { modulo, ra: 3, criterio: "f" };
it("accepts code, name or both, preserves zeros and trims supplied text", () => {
  for (const module of [{ codigo: "0485" }, { nombre: "Programación" }, modulo])
    expect(SkillModuleSchema.parse(module)).toEqual(module);
  expect(SkillModuleSchema.parse({ codigo: " 0485 ", nombre: " Programación " })).toEqual(modulo);
  for (const invalid of [
    {},
    { codigo: 485 },
    { codigo: "" },
    { nombre: " " },
    { codigo: "a\nb" },
    { nombre: "a\tb" },
    { ...modulo, extra: true },
    { codigo: "c".repeat(65) },
    { nombre: "n".repeat(257) },
  ])
    expect(SkillModuleSchema.safeParse(invalid).success).toBe(false);
});
it("validates bounded numeric learning outcomes and optional curricular metadata without requiring it on legacy skills", () => {
  expect(SkillCurricularReferenceSchema.parse(reference)).toEqual(reference);
  for (const patch of [
    { ra: "RA3" },
    { ra: "3" },
    { ra: 0 },
    { ra: 1000 },
    { ra: 1.5 },
    { criterio: "" },
    { criterio: 2 },
    { criterio: "c".repeat(65) },
    { extra: true },
  ])
    expect(SkillCurricularReferenceSchema.safeParse({ ...reference, ...patch }).success).toBe(
      false,
    );
  expect(SkillCurriculumSchema.parse({ modulos: [modulo], fuente: " Normativa " })).toHaveProperty(
    "fuente",
    "Normativa",
  );
  for (const invalid of [
    { modulos: [] },
    { modulos: Array.from({ length: 33 }, () => modulo) },
    { modulos: [modulo], fuente: "f".repeat(2049) },
  ])
    expect(SkillCurriculumSchema.safeParse(invalid).success).toBe(false);
  const base = { name: "testing", description: "Practice testing" };
  expect(SkillFrontmatterSchema.parse(base)).toEqual(base);
  const criterion = {
    codigo: "testing-unitarias",
    enunciado: "Practice",
    referencias: [reference],
  };
  const skill = { ...base, curriculo: { modulos: [modulo] }, criterios: [criterion] };
  expect(SkillFrontmatterSchema.parse(skill)).toEqual(skill);
  for (const referencias of [[], Array.from({ length: 17 }, () => reference)])
    expect(
      SkillFrontmatterSchema.safeParse({ ...skill, criterios: [{ ...criterion, referencias }] })
        .success,
    ).toBe(false);
  expect(SkillCurriculumSummarySchema.parse({ modulos: [], referencias: [] })).toEqual({
    modulos: [],
    referencias: [],
  });
  expect(
    SkillCurriculumSummarySchema.safeParse({
      modulos: Array.from({ length: 1057 }, () => modulo),
      referencias: [],
    }).success,
  ).toBe(false);
  expect(
    SkillCurriculumSummarySchema.safeParse({
      modulos: [],
      referencias: Array.from({ length: 1025 }, () => reference),
    }).success,
  ).toBe(false);
});

it("requires an explicit true opt-in and explains a missing module identity", () => {
  const base = {
    protocolVersion: "0.1",
    requestId: "curriculum-request",
    classId: "class:one",
    kind: "library",
    after: null,
  };
  expect(SkillWorkspaceRequestSchema.parse({ ...base, includeCurriculum: true })).toMatchObject({
    includeCurriculum: true,
  });
  expect(SkillWorkspaceRequestSchema.safeParse({ ...base, includeCurriculum: false }).success).toBe(
    false,
  );
  expect(() => SkillModuleSchema.parse({})).toThrow("Supply a module code, name, or both.");
});
