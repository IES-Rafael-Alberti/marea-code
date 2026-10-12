import { expect, it, vi } from "vitest";
import type { SkillCurriculumSummary, SkillLibraryEntry } from "@marea/protocol";
import {
  curriculumLabels,
  curriculumModules,
  matchesCurriculum,
  matchesSkill,
  moduleKey,
  moduleLabel,
} from "./curriculum.js";
import { CurriculumFilter, CurriculumLabels } from "./curriculum-view.js";
import { skillWorkspaceMessages } from "./messages.js";
import { tree, text, change, control } from "../server-settings/forms.fixture.js";
import { workspaceFixture } from "./workspace.fixture.js";
import { LibrarySkills } from "./panes.js";
const code = { codigo: "0485" },
  name = { nombre: "Programación" },
  both = { ...code, ...name };
it("defaults the library module filter to all and keeps assessment methods outside curricular labels", async () => {
  const { controller: c } = workspaceFixture();
  await c.load();
  c.catalog = c.catalog.map((entry) => ({ ...entry, kind: "evaluation" }));
  const m = skillWorkspaceMessages("en");
  const nodes = tree(
    LibrarySkills({
      c,
      m,
      kind: "evaluation",
      tab: "library",
      catalog: c.catalog,
      query: "",
      search: vi.fn(),
      chooseKind: vi.fn(),
      pick: vi.fn(),
      selection: [],
      source: "all",
      filterSource: vi.fn(),
      filterModule: vi.fn(),
    }),
  );
  expect(control(nodes, m.module).value).toBe("");
  expect(nodes.filter((node) => node.props.className === "skills-curriculum")).toHaveLength(0);
});
it("classifies by exact code or normalized name and resolves only unambiguous known correspondences", async () => {
  const f = workspaceFixture();
  await f.controller.load();
  const base = f.controller.catalog[0];
  if (!base) throw new Error("catalog");
  const entry = (modulos: SkillCurriculumSummary["modulos"]): SkillLibraryEntry => ({
    ...base,
    curriculum: { modulos, referencias: [{ modulo: both, ra: 3, criterio: "f" }] },
  });
  const catalog = [entry([code]), entry([name]), entry([both]), base];
  expect(moduleLabel(code)).toBe("0485");
  expect(moduleLabel(name)).toBe("Programación");
  expect(moduleLabel(both)).toBe("Programación · 0485");
  expect(moduleKey({ nombre: "  ProGramación  " }, catalog)).toBe("code:0485");
  expect(moduleKey(name, [entry([code]), entry([name])])).toBe("name:programación");
  expect(moduleKey(name, [...catalog, entry([{ codigo: "9999", nombre: "Programación" }])])).toBe(
    "name:programación",
  );
  expect(moduleKey({ nombre: "  Entornos  de  desarrollo " }, catalog)).toBe(
    "name:entornos de desarrollo",
  );
  expect(curriculumModules(catalog)).toEqual([["code:0485", "Programación · 0485"]]);
  expect(curriculumModules([entry([both]), entry([{ ...code, nombre: "PROGRAMACIÓN" }])])).toEqual([
    ["code:0485", "Programación · 0485"],
  ]);
  expect(curriculumModules([...catalog, entry([code]), entry([{ nombre: "Algebra" }])])[0]).toEqual(
    ["name:algebra", "Algebra"],
  );
  expect(curriculumLabels(base)).toEqual([]);
  expect(curriculumLabels(entry([both, both]))).toEqual([
    "Programación · 0485",
    "Programación · 0485 · RA3.f",
  ]);
  for (const query of [
    "  ra3.F ",
    "0485",
    "PROGRAMACIÓN",
    "unit testing",
    "testing",
    "testing programación",
  ])
    expect(matchesSkill(entry([both]), query)).toBe(true);
  expect(matchesSkill(base, "RA3.f")).toBe(false);
  expect(matchesCurriculum(base, "", catalog)).toBe(true);
  expect(matchesCurriculum(base, "unlinked", catalog)).toBe(true);
  expect(matchesCurriculum(entry([both]), "unlinked", catalog)).toBe(false);
  expect(matchesCurriculum(entry([name]), "code:0485", catalog)).toBe(true);
  expect(matchesCurriculum(entry([name, { nombre: "Other" }]), "code:0485", catalog)).toBe(true);
  expect(matchesCurriculum(entry([both]), "name:other", catalog)).toBe(false);
  const m = skillWorkspaceMessages("en"),
    changeModule = vi.fn();
  const nodes = tree(
    <CurriculumFilter catalog={catalog} value="code:0485" change={changeModule} messages={m} />,
  );
  expect(nodes.some((node) => text(node) === "Programación · 0485")).toBe(true);
  change(control(nodes, m.module), { value: "unlinked" });
  expect(changeModule).toHaveBeenCalledWith("unlinked");
  expect(text(tree(<CurriculumLabels entry={base} messages={m} />)[0])).toBe(m.unlinked);
  expect(text(tree(<CurriculumLabels entry={entry([both])} messages={m} />)[0])).toContain("RA3.f");
});
