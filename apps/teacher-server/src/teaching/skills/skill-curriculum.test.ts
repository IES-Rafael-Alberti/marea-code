import { expect, it } from "vitest";
import { skillCurriculum } from "./skill-curriculum.boundary.js";
import { parseSkillFrontmatter } from "./frontmatter.boundary.js";
import { syntheticSkill, MemorySkillSource } from "../configuration/dashboard-module.fixture.js";
import { skillAssignmentFixture } from "../../platform/persistence/skill-assignments.fixture.js";
const base = syntheticSkill("didactic", "testing");
const withContent = (content: string) => ({
  ...base,
  files: [{ path: "SKILL.md", content, sizeBytes: content.length }],
});
const content = `---
name: testing
description: Practice
curriculo:
  modulos: [{codigo: '0485', nombre: Programación}]
  fuente: Official source
criterios:
  - codigo: local-1
    referencias:
      - modulo: {nombre: Programación}
        ra: 3
        criterio: f
  - codigo: local-2
---
# Practice
`;
it("keeps curriculum in the complete Markdown while preserving the baseline criterion shape", () => {
  expect(skillCurriculum(withContent(content))).toEqual({
    modulos: [{ codigo: "0485", nombre: "Programación" }, { nombre: "Programación" }],
    referencias: [{ modulo: { nombre: "Programación" }, ra: 3, criterio: "f" }],
  });
  const parsed = parseSkillFrontmatter(content, "testing", "didactic", "SKILL.md");
  expect(parsed.criteria).toEqual([
    { code: "local-1", statement: "", levels: null },
    { code: "local-2", statement: "", levels: null },
  ]);
  for (const bundle of [
    null,
    { ...base, files: [] },
    withContent("no frontmatter"),
    withContent("Body\n" + content),
    withContent("---\nname: testing\ndescription: Practice\n---\nBody"),
  ])
    expect(skillCurriculum(bundle)).toEqual({ modulos: [], referencias: [] });
  expect(
    skillCurriculum(withContent(content.replace(/curriculo:[\s\S]*?criterios:/u, "criterios:"))),
  ).toHaveProperty("modulos", [{ nombre: "Programación" }]);
  expect(() => skillCurriculum(withContent(content.replace("ra: 3", "ra: RA3")))).toThrow();
  expect(
    skillCurriculum({
      ...base,
      files: [
        { path: "README.md", content: "Not the skill", sizeBytes: 13 },
        ...withContent(content).files,
      ],
    }),
  ).toEqual(skillCurriculum(withContent(content)));
  expect(() =>
    skillCurriculum(
      withContent(
        content
          .replace("codigo: local-1", "codigo: &code local-1")
          .replace("codigo: local-2", "codigo: *code"),
      ),
    ),
  ).toThrow();
});
it("returns curricular library fields only on explicit opt-in, leaving old strict dashboards compatible", async () => {
  const f = skillAssignmentFixture();
  f.setSource(new MemorySkillSource([withContent(content)]));
  const legacy = await f.service.execute(f.teacher, f.request({ kind: "library", after: null }));
  if (legacy.kind !== "library") throw new Error("library");
  expect(legacy.skills[0]).not.toHaveProperty("curriculum");
  const current = await f.service.execute(
    f.teacher,
    f.request({ kind: "library", after: null, includeCurriculum: true }),
  );
  if (current.kind !== "library") throw new Error("library");
  expect(current.skills[0]?.curriculum).toEqual(skillCurriculum(withContent(content)));
});
