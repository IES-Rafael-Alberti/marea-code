import { expect, it } from "vitest";
import { SkillFrontmatterSchema } from "./skill-markdown.js";
it("shares the full Markdown frontmatter contract, including optional four-level criteria", () => {
  const minimal = { name: "testing", description: "Practice" };
  expect(SkillFrontmatterSchema.parse(minimal)).toEqual(minimal);
  const criterion = {
    codigo: "RA1",
    enunciado: "Tests boundaries",
    niveles: ["Guided", "Supported", "Independent", "Novel"],
  };
  const full = {
    ...minimal,
    license: "MIT",
    compatibility: "Marea Code",
    metadata: { title: "Testing" },
    criterios: [criterion],
  };
  expect(SkillFrontmatterSchema.parse(full)).toEqual(full);
  expect(
    SkillFrontmatterSchema.parse({ ...minimal, criterios: [{ codigo: "local-1" }] }).criterios,
  ).toEqual([{ codigo: "local-1", enunciado: "" }]);
  for (const patch of [
    { description: " " },
    { description: "a".repeat(1025) },
    { extra: true },
    { compatibility: "a".repeat(501) },
    { metadata: { title: 42 } },
    { criterios: Array.from({ length: 65 }, () => criterion) },
  ])
    expect(SkillFrontmatterSchema.safeParse({ ...minimal, ...patch }).success).toBe(false);
  for (const patch of [
    { codigo: " " },
    { codigo: "x".repeat(65) },
    { codigo: "a\tb" },
    { enunciado: "a\nb" },
    { enunciado: "a".repeat(1025) },
    { niveles: ["a", "b", "c"] },
    { niveles: ["a", "b", "c", "d", "e"] },
    { niveles: ["a", "b", "c", " "] },
    { niveles: ["a", "b", "c", "d\te"] },
    { niveles: ["a", "b", "c", "d".repeat(1025)] },
  ])
    expect(
      SkillFrontmatterSchema.safeParse({ ...minimal, criterios: [{ ...criterion, ...patch }] })
        .success,
    ).toBe(false);
});
