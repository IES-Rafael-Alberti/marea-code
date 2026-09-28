import { describe, expect, it } from "vitest";

import { BundledSkillError } from "./errors.js";
import { parseSkillFrontmatter } from "./frontmatter.boundary.js";

const LOCATION = "didactic/testing/SKILL.md";

function frontmatter(yaml: string): string {
  return `---\n${yaml}\n---\n\n# Skill\n`;
}

function expectInvalid(action: () => object, message: string): void {
  let error: Error | undefined;
  try {
    action();
  } catch (caught) {
    if (caught instanceof Error) {
      error = caught;
    }
  }
  expect(error).toBeInstanceOf(BundledSkillError);
  expect(error).toMatchObject({ code: "INVALID_FRONTMATTER" });
  expect(String(error)).toContain(message);
}

describe("parseSkillFrontmatter", () => {
  it("parses the DeepAgents fields and Marea criteria strictly", () => {
    const parsed = parseSkillFrontmatter(
      frontmatter(`name: testing
description: " Decide qué probar y cuándo usar pruebas "
license: MIT
compatibility: Marea Code
metadata:
  audience: students
criterios:
  - codigo: RA5.c
    enunciado: " Elegir casos "
    niveles:
      - With direct guidance
      - With occasional help
      - Autonomously
      - In a novel situation`),
      "testing",
      "didactic",
      LOCATION,
    );

    expect(parsed).toEqual({
      name: "testing",
      description: "Decide qué probar y cuándo usar pruebas",
      license: "MIT",
      compatibility: "Marea Code",
      criteria: [
        {
          code: "RA5.c",
          statement: "Elegir casos",
          levels: [
            "With direct guidance",
            "With occasional help",
            "Autonomously",
            "In a novel situation",
          ],
        },
      ],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.criteria)).toBe(true);
    expect(Object.isFrozen(parsed.criteria[0])).toBe(true);
    expect(Object.isFrozen(parsed.criteria[0]?.levels)).toBe(true);
  });

  it("normalizes omitted optional fields and criteria levels", () => {
    const parsed = parseSkillFrontmatter(
      frontmatter(`name: testing
description: Testing guidance
criterios:
  - codigo: RA5.c`),
      "testing",
      "didactic",
      LOCATION,
    );

    expect(parsed).toEqual({
      name: "testing",
      description: "Testing guidance",
      license: null,
      compatibility: null,
      criteria: [{ code: "RA5.c", statement: "", levels: null }],
    });
  });

  it("accepts an evaluation skill without didactic criteria", () => {
    expect(
      parseSkillFrontmatter(
        frontmatter("name: review\ndescription: Review a session"),
        "review",
        "evaluation",
        "evaluation/review/SKILL.md",
      ).criteria,
    ).toEqual([]);
  });

  it("requires DeepAgents frontmatter delimiters", () => {
    expectInvalid(
      () => parseSkillFrontmatter("# Missing", "testing", "didactic", LOCATION),
      "Add YAML frontmatter",
    );
  });

  it("requires frontmatter to start at the first byte", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          `prefix\n${frontmatter("name: testing\ndescription: ok")}`,
          "testing",
          "didactic",
          LOCATION,
        ),
      "Add YAML frontmatter",
    );
  });

  it("reports YAML syntax errors", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: [testing\ndescription: broken"),
          "testing",
          "didactic",
          LOCATION,
        ),
      "Fix the YAML syntax",
    );
  });

  it.each(["- testing\n- description", "testing", "null"])(
    "requires a YAML mapping for %s",
    (yaml) => {
      expectInvalid(
        () => parseSkillFrontmatter(frontmatter(yaml), "testing", "didactic", LOCATION),
        "Use a YAML mapping",
      );
    },
  );

  it("rejects duplicate YAML keys", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: testing\nname: other\ndescription: ok"),
          "testing",
          "didactic",
          LOCATION,
        ),
      "Fix the YAML syntax",
    );
  });

  it("rejects aliases so YAML cannot amplify bundled input", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: testing\ndescription: &description Testing\nlicense: *description"),
          "testing",
          "didactic",
          LOCATION,
        ),
      "Fix the YAML syntax",
    );
  });

  it.each([
    ["name: testing", "description"],
    ["name: testing\ndescription: ok\nextra: no", "frontmatter"],
    [`name: testing\ndescription: ${"x".repeat(1_025)}`, "description"],
    [`name: testing\ndescription: ok\ncompatibility: ${"x".repeat(501)}`, "compatibility"],
    ["name: testing\ndescription: ok\nmetadata: []", "metadata"],
    ["name: testing\ndescription: ok\ncriterios: wrong", "criterios"],
    [
      "name: testing\ndescription: ok\ncriterios:\n  - codigo: RA\n    niveles: [one, two]",
      "criterios.0.niveles",
    ],
  ])("reports an actionable schema error for %s", (yaml, field) => {
    expectInvalid(
      () => parseSkillFrontmatter(frontmatter(yaml), "testing", "didactic", LOCATION),
      `Fix ${field}`,
    );
  });

  it("separates multiple schema issues in one actionable message", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: []\ndescription: []"),
          "testing",
          "didactic",
          LOCATION,
        ),
      "; Fix description:",
    );
  });

  it("rejects names outside Marea's portable skill subset", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: Testing\ndescription: ok"),
          "Testing",
          "didactic",
          LOCATION,
        ),
      "Use a 1-64 character portable name",
    );
  });

  it("requires the name to match its directory", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: other\ndescription: ok"),
          "testing",
          "didactic",
          LOCATION,
        ),
      "Rename the directory",
    );
  });

  it("rejects executable skill modules", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: testing\ndescription: ok\nmodule: script.ts"),
          "testing",
          "didactic",
          LOCATION,
        ),
      "cannot execute code",
    );
  });

  it("rejects allowed-tools because it cannot grant effective permissions", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: testing\ndescription: ok\nallowed-tools: read_file"),
          "testing",
          "didactic",
          LOCATION,
        ),
      "Remove `allowed-tools`; educational skill metadata cannot grant tool permissions",
    );
  });

  it("rejects duplicate criterion codes within one skill", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter(
            "name: testing\ndescription: ok\ncriterios:\n  - codigo: RA5.c\n  - codigo: RA5.c",
          ),
          "testing",
          "didactic",
          LOCATION,
        ),
      "Give each criterion a unique `codigo`",
    );
  });

  it("accepts criterion values and counts at their exact limits", () => {
    const criterion = `  - codigo: ${"c".repeat(64)}\n    enunciado: ${"s".repeat(1_024)}\n    niveles:\n      - ${"l".repeat(1_024)}\n      - two\n      - three\n      - four`;
    const criteria = Array.from({ length: 64 }, (_, index) =>
      index === 0 ? criterion : `  - codigo: C${String(index)}`,
    ).join("\n");

    const parsed = parseSkillFrontmatter(
      frontmatter(`name: testing\ndescription: ok\ncriterios:\n${criteria}`),
      "testing",
      "didactic",
      LOCATION,
    );

    expect(parsed.criteria).toHaveLength(64);
    expect(parsed.criteria[0]?.code).toHaveLength(64);
    expect(parsed.criteria[0]?.statement).toHaveLength(1_024);
    expect(parsed.criteria[0]?.levels?.[0]).toHaveLength(1_024);
  });

  it.each([
    [`  - codigo: ${"c".repeat(65)}`, "criterios.0.codigo"],
    [`  - codigo: code\n    enunciado: ${"s".repeat(1_025)}`, "criterios.0.enunciado"],
    [
      `  - codigo: code\n    niveles: [${"l".repeat(1_025)}, two, three, four]`,
      "criterios.0.niveles.0",
    ],
  ])("bounds criterion text for %s", (criterion, field) => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter(`name: testing\ndescription: ok\ncriterios:\n${criterion}`),
          "testing",
          "didactic",
          LOCATION,
        ),
      `Fix ${field}`,
    );
  });

  it("allows no more than 64 criteria", () => {
    const criteria = Array.from({ length: 65 }, (_, index) => `  - codigo: C${String(index)}`).join(
      "\n",
    );
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter(`name: testing\ndescription: ok\ncriterios:\n${criteria}`),
          "testing",
          "didactic",
          LOCATION,
        ),
      "Fix criterios",
    );
  });

  it.each([
    ['  - codigo: "RA\\u0007"', "criterios.0.codigo"],
    ['  - codigo: code\n    enunciado: "bad\\u0007statement"', "criterios.0.enunciado"],
    [
      '  - codigo: code\n    niveles: ["bad\\u0007level", two, three, four]',
      "criterios.0.niveles.0",
    ],
  ])("rejects control characters in %s", (criterion, field) => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter(`name: testing\ndescription: ok\ncriterios:\n${criterion}`),
          "testing",
          "didactic",
          LOCATION,
        ),
      `Fix ${field}: Control characters are not allowed`,
    );
  });

  it("keeps learning criteria out of evaluation skills", () => {
    expectInvalid(
      () =>
        parseSkillFrontmatter(
          frontmatter("name: review\ndescription: ok\ncriterios: []"),
          "review",
          "evaluation",
          "evaluation/review/SKILL.md",
        ),
      "evaluation method, not learning criteria",
    );
  });
});
