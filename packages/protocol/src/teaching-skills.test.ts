import { describe, expect, it } from "vitest";

import {
  CURRENT_PROTOCOL_VERSION,
  isSkillFilePath,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_RESPONSE_BYTES,
  RunSkillRequestSchema,
  RunSkillResponseSchema,
  SkillBundleSchema,
  SkillCriterionSchema,
  SkillFileSchema,
} from "./index.js";

const criterion = { code: "C1", statement: "Explain", levels: ["One", "Two", "Three", "Four"] };
const file = { path: "SKILL.md", content: "Teach.", sizeBytes: 6 };
const bundle = {
  id: "teacher/t1/testing",
  name: "testing",
  description: "Practice testing",
  kind: "didactic",
  source: "teacher",
  digest: `sha256:${"a".repeat(64)}`,
  license: null,
  compatibility: null,
  criteria: [criterion],
  files: [file],
};
const envelope = {
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  requestId: "request:1",
  runId: "run:1",
  snapshotId: "snapshot:1",
};

describe("skill content contract", () => {
  it.each([
    "SKILL.md",
    "resources/guide.md",
    "resources/nested/Guía.TXT",
    "resources/a.csv",
    "resources/a.json",
    "resources/a.yaml",
    "resources/a.yml",
  ])("accepts %s", (path) => {
    expect(isSkillFilePath(path)).toBe(true);
  });
  it.each([
    "",
    "skill.md",
    "/SKILL.md",
    "../SKILL.md",
    "resources",
    "resources/",
    "resources/.hidden.txt",
    "resources/../a.txt",
    "resources/a\\b.txt",
    "resources//a.md",
    "resources/a\0.txt",
    "resources/a\n.txt",
    "resources/a.md\n",
    "resources/a.md\r",
    "resources/a.md.bak",
    "resources/a.ts",
    "other/a.md",
  ])("rejects %j", (path) => {
    expect(isSkillFilePath(path)).toBe(false);
    expect(SkillFileSchema.safeParse({ ...file, path }).success).toBe(false);
  });
  it("checks exact UTF-8 bytes and accepts both empty files and the maximum", () => {
    expect(MAX_SKILL_FILE_BYTES).toBe(524_288);
    for (const content of ["", "á", "🙂", "x".repeat(MAX_SKILL_FILE_BYTES)]) {
      const value = { ...file, content, sizeBytes: new TextEncoder().encode(content).byteLength };
      const parsed = SkillFileSchema.parse(value);
      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    for (const sizeBytes of [-1, 1.5, 7, MAX_SKILL_FILE_BYTES + 1]) {
      expect(SkillFileSchema.safeParse({ ...file, sizeBytes }).success).toBe(false);
    }
    expect(SkillFileSchema.safeParse({ ...file, content: "á", sizeBytes: 1 }).success).toBe(false);
    expect(SkillFileSchema.safeParse({ ...file, extra: true }).success).toBe(false);
    expect(
      SkillFileSchema.safeParse({ ...file, path: `resources/${"x".repeat(1_024)}.txt` }).success,
    ).toBe(false);
  });
  it("preserves actionable validation messages", () => {
    expect(() => SkillFileSchema.parse({ ...file, content: "a\0b", sizeBytes: 3 })).toThrow(
      "Skill text cannot contain NUL bytes.",
    );
    expect(() => SkillFileSchema.parse({ ...file, path: "../a.txt" })).toThrow(
      "Use a contained skill text-file path.",
    );
    expect(() => SkillFileSchema.parse({ ...file, sizeBytes: 3 })).toThrow(
      "Skill file size must match its UTF-8 content.",
    );
    for (const [value, message] of [
      [{ ...bundle, source: "center" }, "Skill metadata must match its source identity."],
      [{ ...bundle, kind: "evaluation" }, "Only didactic skills define learning criteria."],
      [{ ...bundle, criteria: [criterion, criterion] }, "Skill criterion codes must be unique."],
      [
        { ...bundle, files: [{ ...file, path: "resources/a.txt" }] },
        "A skill must contain SKILL.md.",
      ],
      [{ ...bundle, files: [file, file] }, "Skill file paths must be unique."],
    ] as const)
      expect(() => SkillBundleSchema.parse(value)).toThrow(message);
  });
  it("accepts distinct criteria and multi-part portable names", () => {
    const value = {
      ...bundle,
      id: "teacher/t1/testing-code",
      name: "testing-code",
      criteria: [criterion, { ...criterion, code: "C2" }],
    };
    expect(SkillBundleSchema.parse(value)).toEqual(value);
  });
  it("freezes metadata, criteria, levels and file collections", () => {
    const parsed = SkillBundleSchema.parse(bundle);
    expect(parsed).toEqual(bundle);
    for (const value of [
      parsed,
      parsed.criteria,
      parsed.criteria[0],
      parsed.criteria[0]?.levels,
      parsed.files,
      parsed.files[0],
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(
      SkillCriterionSchema.parse({ ...criterion, statement: "", levels: null }).levels,
    ).toBeNull();
    expect(SkillBundleSchema.parse({ ...bundle, kind: "evaluation", criteria: [] }).kind).toBe(
      "evaluation",
    );
    expect(
      SkillBundleSchema.parse({ ...bundle, id: "marea/testing", source: "marea" }).source,
    ).toBe("marea");
    expect(
      SkillBundleSchema.parse({ ...bundle, id: "center/c1/testing", source: "center" }).source,
    ).toBe("center");
  });
  it("enforces criterion limits and four nonempty levels", () => {
    for (const value of [
      { ...criterion, code: "" },
      { ...criterion, code: "x".repeat(65) },
      { ...criterion, statement: "x".repeat(1_025) },
      { ...criterion, levels: [] },
      { ...criterion, levels: ["1", "2", "3"] },
      { ...criterion, levels: ["1", "2", "3", "4", "5"] },
      { ...criterion, levels: ["", "2", "3", "4"] },
      { ...criterion, levels: ["x".repeat(1_025), "2", "3", "4"] },
      { ...criterion, extra: true },
    ])
      expect(SkillCriterionSchema.safeParse(value).success).toBe(false);
  });
  it("rejects mismatched identities, evaluation criteria and duplicate metadata", () => {
    for (const value of [
      { ...bundle, source: "center" },
      { ...bundle, name: "other" },
      { ...bundle, name: "t1/testing" },
      { ...bundle, name: "" },
      { ...bundle, name: "a".repeat(65) },
      { ...bundle, description: "" },
      { ...bundle, description: "x".repeat(1_025) },
      { ...bundle, compatibility: "x".repeat(501) },
      { ...bundle, license: "x".repeat(MAX_SKILL_FILE_BYTES + 1) },
      { ...bundle, kind: "evaluation" },
      { ...bundle, criteria: [criterion, criterion] },
      {
        ...bundle,
        criteria: Array.from({ length: 65 }, (_, index) => ({ ...criterion, code: String(index) })),
      },
      { ...bundle, files: [] },
      { ...bundle, files: [file, file] },
      { ...bundle, files: [{ ...file, path: "resources/guide.md" }] },
      { ...bundle, extra: true },
    ])
      expect(SkillBundleSchema.safeParse(value).success).toBe(false);
  });
  it("bounds total bytes separately from each file and file count", () => {
    expect(MAX_SKILL_BUNDLE_BYTES).toBe(8_388_608);
    expect(MAX_SKILL_RESPONSE_BYTES).toBe(67_108_864);
    const content = "x".repeat(MAX_SKILL_FILE_BYTES);
    const files = Array.from({ length: 16 }, (_, index) => ({
      path: index === 0 ? "SKILL.md" : `resources/${String(index)}.txt`,
      content,
      sizeBytes: MAX_SKILL_FILE_BYTES,
    }));
    expect(SkillBundleSchema.safeParse({ ...bundle, files }).success).toBe(true);
    expect(() =>
      SkillBundleSchema.parse({
        ...bundle,
        files: [...files, { path: "resources/overflow.txt", content: "x", sizeBytes: 1 }],
      }),
    ).toThrow("Skill bundle exceeds the byte limit.");
    const emptyFiles = Array.from({ length: 255 }, (_, index) => ({
      path: `resources/${String(index)}.txt`,
      content: "",
      sizeBytes: 0,
    }));
    expect(SkillBundleSchema.safeParse({ ...bundle, files: [file, ...emptyFiles] }).success).toBe(
      true,
    );
    expect(
      SkillBundleSchema.safeParse({
        ...bundle,
        files: [file, ...emptyFiles, { path: "resources/extra.txt", content: "", sizeBytes: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe("run-scoped skill delivery", () => {
  it("requires a strict run, snapshot and skill identity request", () => {
    const request = { ...envelope, skillId: bundle.id };
    expect(RunSkillRequestSchema.parse(request)).toEqual(request);
    expect(Object.isFrozen(RunSkillRequestSchema.parse(request))).toBe(true);
    expect(RunSkillRequestSchema.safeParse({ ...request, path: "/etc/passwd" }).success).toBe(
      false,
    );
    for (const key of Object.keys(request)) {
      expect(
        RunSkillRequestSchema.safeParse(
          Object.fromEntries(Object.entries(request).filter(([name]) => name !== key)),
        ).success,
      ).toBe(false);
    }
  });
  it("accepts only didactic bundles in student responses", () => {
    const response = { ...envelope, skill: bundle };
    expect(RunSkillResponseSchema.parse(response)).toEqual(response);
    expect(Object.isFrozen(RunSkillResponseSchema.parse(response))).toBe(true);
    expect(RunSkillResponseSchema.safeParse({ ...response, privateNotes: "Private" }).success).toBe(
      false,
    );
    expect(() =>
      RunSkillResponseSchema.parse({
        ...response,
        skill: { ...bundle, kind: "evaluation", criteria: [] },
      }),
    ).toThrow("Evaluation skills cannot be delivered to students.");
    for (const key of Object.keys(response)) {
      expect(
        RunSkillResponseSchema.safeParse(
          Object.fromEntries(Object.entries(response).filter(([name]) => name !== key)),
        ).success,
      ).toBe(false);
    }
  });
});
