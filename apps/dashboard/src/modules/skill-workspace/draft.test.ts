import { expect, it } from "vitest";
import {
  copySkillDraft,
  editSkillFields,
  newSkillDraft,
  skillEditorFields,
  validSkillDraft,
} from "./draft.boundary.js";

it("creates a portable identity while retaining the teacher's human title and validates required fields", () => {
  const draft = newSkillDraft("didactic");
  expect(validSkillDraft(draft)).toBe(false);
  const next = editSkillFields(draft, {
    title: "Pruebas unitarias básicas",
    description: "Practica testing",
    instructions: "Propón un ejercicio pequeño.",
    criteria: [{ codigo: "RA1.a", enunciado: "Escribe una prueba" }],
  });
  expect(next.slug).toBe(draft.slug);
  expect(validSkillDraft(next)).toBe(true);
  expect(skillEditorFields(next)).toEqual({
    title: "Pruebas unitarias básicas",
    description: "Practica testing",
    instructions: "Propón un ejercicio pequeño.",
    criteria: [{ codigo: "RA1.a", enunciado: "Escribe una prueba" }],
  });
  expect(
    validSkillDraft(editSkillFields(next, { criteria: [{ codigo: "", enunciado: "" }] })),
  ).toBe(false);
});

it("preserves imported metadata, comments, criteria levels and companion files through editing and copying", () => {
  const draft = {
    slug: "testing",
    kind: "didactic" as const,
    files: [
      {
        path: "SKILL.md",
        content:
          "---\r\nname: testing\r\ndescription: Practice\r\nlicense: MIT # keep this\r\nmetadata:\r\n  custom: retained\r\ncriterios:\r\n  - codigo: RA1\r\n    niveles: [one, two, three, four]\r\n---\r\nOriginal body",
      },
      { path: "resources/help.txt", content: "Companion" },
    ],
  };
  const next = editSkillFields(draft, { title: "Testing revised" });
  expect(next.files[0]?.content).toContain("# keep this");
  expect(next.files[0]?.content).toContain("custom: retained");
  expect(skillEditorFields(next)?.criteria[0]?.niveles).toEqual(["one", "two", "three", "four"]);
  expect(next.files[1]).toEqual(draft.files[1]);
  const copy = copySkillDraft(next);
  expect(copy.slug).not.toBe(next.slug);
  expect(copy.files[0]?.content).toContain(`name: ${copy.slug}`);
  expect(copy.files[1]).toEqual(draft.files[1]);
});

it.each([
  "no frontmatter",
  "---\nname: [broken\n---\n",
  "---\nname: 42\ndescription: wrong\n---\n",
  "---\nname: test\ndescription: &value x\nmetadata: {copied: *value}\n---\n",
])("keeps an invalid imported document available for advanced editing: %s", (content) => {
  const draft = { slug: "test", kind: "didactic" as const, files: [{ path: "SKILL.md", content }] };
  expect(skillEditorFields(draft)).toBeNull();
  expect(validSkillDraft(draft)).toBe(false);
});

it("derives a readable fallback title from an imported skill without metadata", () => {
  expect(
    skillEditorFields({
      slug: "unit-tests",
      kind: "didactic",
      files: [
        { path: "SKILL.md", content: "---\nname: unit-tests\ndescription: Practice\n---\nTry it" },
      ],
    })?.title,
  ).toBe("unit tests");
});

it("enforces exact field and criterion bounds, including whitespace and duplicate criterion codes", () => {
  const base = editSkillFields(newSkillDraft("didactic"), {
    title: "Test",
    description: "Practice",
    instructions: "Try one test",
  });
  expect(base.slug).toMatch(
    /^skill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
  for (const update of [
    { title: " " },
    { title: "a".repeat(257) },
    { description: " " },
    { description: "a".repeat(1025) },
    { instructions: "\n " },
    { criteria: [{ codigo: " ", enunciado: "" }] },
    {
      criteria: [
        { codigo: "x", enunciado: "one" },
        { codigo: " x ", enunciado: "two" },
      ],
    },
    {
      criteria: Array.from({ length: 65 }, (_, i) => ({ codigo: `c${String(i)}`, enunciado: "" })),
    },
  ])
    expect(validSkillDraft(editSkillFields(base, update))).toBe(false);
  expect(
    validSkillDraft(
      editSkillFields(base, {
        title: "t".repeat(256),
        description: "d".repeat(1024),
        criteria: Array.from({ length: 64 }, (_, i) => ({
          codigo: `c${String(i)}`,
          enunciado: "",
        })),
      }),
    ),
  ).toBe(true);
  expect(
    validSkillDraft(
      editSkillFields(base, {
        criteria: [
          { codigo: " a ", enunciado: "" },
          { codigo: "b", enunciado: "" },
        ],
      }),
    ),
  ).toBe(true);
  expect(validSkillDraft({ ...base, kind: "evaluation" })).toBe(true);
  expect(
    validSkillDraft({
      ...editSkillFields(base, { criteria: [{ codigo: "a", enunciado: "" }] }),
      kind: "evaluation",
    }),
  ).toBe(false);
});
it("rejects misplaced or ambiguous frontmatter, and accepts a closing delimiter at EOF", () => {
  const draft = newSkillDraft("didactic");
  expect(() => editSkillFields({ ...draft, files: [] }, {})).toThrow("invalid");
  for (const content of [
    "preamble\n---\nname: x\ndescription: valid\n---\n",
    "---\nname: x\nname: y\ndescription: valid\n---\n",
    "not frontmatter",
  ])
    expect(() => editSkillFields({ ...draft, files: [{ path: "SKILL.md", content }] }, {})).toThrow(
      "invalid",
    );
  expect(
    skillEditorFields({
      ...draft,
      files: [{ path: "SKILL.md", content: "---\nname: x\ndescription: valid\n---" }],
    }),
  ).toMatchObject({ title: "x", instructions: "" });
});
