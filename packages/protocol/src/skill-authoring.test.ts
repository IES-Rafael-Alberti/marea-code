import { expect, expectTypeOf, it } from "vitest";

import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  SkillAuthoringCopyRequestSchema,
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringDraftSchema,
  SkillAuthoringReadRequestSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringReadTargetSchema,
  SkillAuthoringSaveRequestSchema,
  SkillAuthoringSaveResponseSchema,
  SkillAuthoringValidateRequestSchema,
  SkillAuthoringValidateResponseSchema,
  type SkillAuthoringDraft,
  type SkillAuthoringValidateResponse,
  type SkillAuthoringSaveResponse,
  type SkillAuthoringCopyResponse,
} from "./index.js";
import {
  classId,
  digest,
  draftFileFixture,
  draftFixture,
  parseCopyRequest,
  parseReadRequest,
  parseReadResponse,
  parseSaveRequest,
  parseValidateRequest,
  parseValidatedResponse,
  readRequestFixture,
} from "./skill-authoring.fixture.js";

const encoder = new TextEncoder();

it("preserves exact response types across authoring operations", () => {
  expectTypeOf<
    SkillAuthoringValidateResponse["kind"]
  >().toEqualTypeOf<"skill-authoring-validated">();
  expectTypeOf<SkillAuthoringSaveResponse["kind"]>().toEqualTypeOf<"skill-authoring-saved">();
  expectTypeOf<SkillAuthoringCopyResponse["kind"]>().toEqualTypeOf<"skill-authoring-copied">();
  expectTypeOf<SkillAuthoringValidateResponse>().not.toExtend<SkillAuthoringSaveResponse>();
  expectTypeOf<SkillAuthoringSaveResponse>().not.toExtend<SkillAuthoringCopyResponse>();
  expectTypeOf<SkillAuthoringCopyResponse>().not.toExtend<SkillAuthoringValidateResponse>();
});

it("parses readonly catalog and personal read targets without nested unknown fields", () => {
  expect(
    SkillAuthoringReadTargetSchema.parse({ scope: "catalog", skillId: "marea/bundled" }),
  ).toEqual({ scope: "catalog", skillId: "marea/bundled" });
  expect(SkillAuthoringReadTargetSchema.parse({ scope: "personal", slug: "testing" })).toEqual({
    scope: "personal",
    slug: "testing",
  });
  expect(
    SkillAuthoringReadTargetSchema.safeParse({ extra: 1, scope: "personal", slug: "x" }).success,
  ).toBe(false);
  expect(SkillAuthoringReadTargetSchema.safeParse({ scope: "owner", slug: "x" }).success).toBe(
    false,
  );
  expect(
    SkillAuthoringReadTargetSchema.safeParse({
      scope: "personal",
      slug: "x",
      skillId: "marea/bundled",
    }).success,
  ).toBe(false);
  expect(
    SkillAuthoringReadTargetSchema.safeParse({ scope: "catalog", skillId: "owner/x" }).success,
  ).toBe(false);
  expect(parseReadRequest().target).toEqual({ scope: "personal", slug: "testing" });
  expect(
    parseReadRequest({ target: { scope: "catalog", skillId: "marea/bundled" } }).target,
  ).toEqual({
    scope: "catalog",
    skillId: "marea/bundled",
  });
});

it("rejects malformed authoring envelopes before content inspection", () => {
  for (const patch of [
    { classId: "" },
    { classId: "-bad" },
    { protocolVersion: "2.0" },
    { requestId: "" },
    { kind: "skill-authoring-delete" },
    { kind: "skill-authoring-save" },
    { target: { scope: "personal", slug: "Bad Slug" } },
  ] as const) {
    expect(SkillAuthoringReadRequestSchema.safeParse(readRequestFixture(patch)).success).toBe(
      false,
    );
  }
  expect(
    SkillAuthoringReadRequestSchema.safeParse({ ...readRequestFixture(), extra: true }).success,
  ).toBe(false);
  expect(
    SkillAuthoringValidateRequestSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-validate",
    }).success,
  ).toBe(false);
  expect(
    SkillAuthoringValidateRequestSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-validate",
      draft: draftFixture(),
    }).success,
  ).toBe(false);
  expect(
    SkillAuthoringSaveRequestSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-save",
    }).success,
  ).toBe(false);
  expect(
    SkillAuthoringCopyRequestSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-copy",
    }).success,
  ).toBe(false);
  expect(SkillAuthoringReadRequestSchema.safeParse(readRequestFixture()).success).toBe(true);
});

it("validates drafts with exact byte, file and path boundaries", () => {
  const maximumFile = draftFileFixture({ content: "x".repeat(MAX_SKILL_FILE_BYTES) });
  const oversized = SkillAuthoringDraftSchema.safeParse(draftFixture({ files: [maximumFile] }));
  expect(oversized.success).toBe(true);
  expect(
    SkillAuthoringDraftSchema.safeParse(
      draftFixture({
        files: [draftFileFixture({ content: "x".repeat(MAX_SKILL_FILE_BYTES + 1) })],
      }),
    ).success,
  ).toBe(false);
  const manyFiles = Array.from({ length: 255 }, (_, index) =>
    draftFileFixture({ content: "x", path: `resources/file-${String(index)}.txt` }),
  ).concat(draftFileFixture()) as SkillAuthoringDraft["files"];
  expect(SkillAuthoringDraftSchema.safeParse(draftFixture({ files: manyFiles })).success).toBe(
    true,
  );
  expect(
    SkillAuthoringDraftSchema.safeParse(draftFixture({ files: [...manyFiles, draftFileFixture()] }))
      .success,
  ).toBe(false);
  expect(SkillAuthoringDraftSchema.safeParse(draftFixture({ files: [] })).success).toBe(false);
  const bundleFile = draftFileFixture({ content: "x".repeat(MAX_SKILL_FILE_BYTES) });
  const fullBundle = SkillAuthoringDraftSchema.safeParse(
    draftFixture({
      files: Array.from({ length: 16 }, (_, index) =>
        index === 0 ? bundleFile : { ...bundleFile, path: `resources/full-${String(index)}.txt` },
      ),
    }),
  );
  expect(fullBundle.success).toBe(true);
  expect(
    SkillAuthoringDraftSchema.safeParse(
      draftFixture({
        files: [
          ...Array.from({ length: 17 }, (_, index) =>
            index === 0
              ? bundleFile
              : { ...bundleFile, path: `resources/over-${String(index)}.txt` },
          ),
        ],
      }),
    ).success,
  ).toBe(false);
  const parsed = SkillAuthoringDraftSchema.parse(draftFixture());
  expect(parsed).toEqual(draftFixture());
  const evaluation = SkillAuthoringDraftSchema.parse(draftFixture({ kind: "evaluation" }));
  expect(evaluation.kind).toBe("evaluation");
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.files)).toBe(true);
});

it("rejects unsafe draft paths, duplicates, NUL and malformed Unicode", () => {
  for (const files of [
    [draftFileFixture({ path: "../escape.md" })],
    [
      draftFileFixture(),
      draftFileFixture({ path: "resources/a.txt" }),
      draftFileFixture({ path: "resources/a.txt" }),
    ],
    [draftFileFixture({ content: "a\0b" })],
    [draftFileFixture({ content: "\ud800" })],
    [draftFileFixture({ path: "resources/.hidden.txt" })],
    [draftFileFixture({ path: `resources/${"x".repeat(1_024)}.txt` })],
  ] as const) {
    expect(SkillAuthoringDraftSchema.safeParse(draftFixture({ files: [...files] })).success).toBe(
      false,
    );
  }
  expect(() =>
    SkillAuthoringDraftSchema.parse(
      draftFixture({ files: [draftFileFixture({ path: "../escape.md" })] }),
    ),
  ).toThrow("Use a contained skill text-file path.");
  expect(() =>
    SkillAuthoringDraftSchema.parse(
      draftFixture({ files: [draftFileFixture({ content: "a\0b" })] }),
    ),
  ).toThrow("Skill text cannot contain NUL bytes.");
  expect(() =>
    SkillAuthoringDraftSchema.parse(
      draftFixture({ files: [draftFileFixture({ content: "\ud800" })] }),
    ),
  ).toThrow("Skill text must be valid Unicode.");
  expect(() =>
    SkillAuthoringDraftSchema.parse(
      draftFixture({
        files: [draftFileFixture({ content: "x".repeat(MAX_SKILL_FILE_BYTES + 1) })],
      }),
    ),
  ).toThrow("Skill file exceeds the byte limit.");
  expect(() => SkillAuthoringDraftSchema.parse(draftFixture({ files: [] }))).toThrow(
    "A skill draft must contain SKILL.md.",
  );
  expect(
    SkillAuthoringDraftSchema.safeParse(
      draftFixture({ files: [draftFileFixture({ path: "resources/only.txt" })] }),
    ).success,
  ).toBe(false);
  expect(() =>
    SkillAuthoringDraftSchema.parse(
      draftFixture({ files: [draftFileFixture(), draftFileFixture()] }),
    ),
  ).toThrow("Skill file paths must be unique.");
  expect(() =>
    SkillAuthoringDraftSchema.parse(
      draftFixture({
        files: [draftFileFixture({ content: "x".repeat(MAX_SKILL_BUNDLE_BYTES + 1) })],
      }),
    ),
  ).toThrow("Skill draft exceeds the bundle byte limit.");
  expect(() => SkillAuthoringDraftSchema.parse({ ...draftFixture(), extra: true })).toThrow();
  expect(() => SkillAuthoringDraftSchema.parse(draftFixture({ slug: "Bad Slug" }))).toThrow();
  expect(
    SkillAuthoringDraftSchema.safeParse(JSON.parse('{"kind":"module","files":[],"slug":"x"}'))
      .success,
  ).toBe(false);
  expect(
    SkillAuthoringDraftSchema.safeParse(JSON.parse('{"kind":"","files":[],"slug":"x"}')).success,
  ).toBe(false);
  expect(
    SkillAuthoringDraftSchema.safeParse(
      JSON.parse('{"files":[{"extra":true}],"kind":"didactic","slug":"x"}'),
    ).success,
  ).toBe(false);
});

it("supports create-only and replace digests without caller identity authority", () => {
  expect(parseSaveRequest().expectedDigest).toBeNull();
  expect(parseSaveRequest({ expectedDigest: digest }).expectedDigest).toBe(digest);
  expect(
    SkillAuthoringSaveRequestSchema.safeParse({
      ...readRequestFixture(),
      draft: draftFixture(),
      expectedDigest: "digest",
      kind: "skill-authoring-save",
    }).success,
  ).toBe(false);
  expect(
    SkillAuthoringSaveRequestSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-save",
    }).success,
  ).toBe(false);
  expect(parseCopyRequest().sourceDigest).toBe(digest);
  expect(
    SkillAuthoringCopyRequestSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-copy",
      slug: "copied",
      sourceDigest: null,
      sourceSkillId: "marea/bundled",
    }).success,
  ).toBe(false);
  expect(
    SkillAuthoringCopyRequestSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-copy",
      slug: "Bad Slug",
      sourceDigest: digest,
      sourceSkillId: "marea/bundled",
    }).success,
  ).toBe(false);
  expect(
    SkillAuthoringCopyRequestSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-copy",
      slug: "copied",
      sourceDigest: digest,
      sourceSkillId: "owner/other",
    }).success,
  ).toBe(false);
  expect(
    SkillAuthoringCopyRequestSchema.safeParse(
      parseCopyRequest({ sourceSkillId: "marea/bundled", sourceDigest: digest }),
    ).success,
  ).toBe(true);
});

it("correlates read results and nullable personal readback", () => {
  const readback = parseReadResponse();
  expect(readback.editable).toBe(false);
  expect(readback.skill).toBeNull();
  expect(SkillAuthoringReadResponseSchema.safeParse(readRequestFixture()).success).toBe(false);
  expect(() => parseReadResponse({ editable: true })).toThrow(
    "A missing skill cannot be editable.",
  );
  expect(
    SkillAuthoringReadResponseSchema.safeParse({ ...parseReadResponse(), extra: true }).success,
  ).toBe(false);
  expect(
    SkillAuthoringReadResponseSchema.safeParse({
      ...readRequestFixture(),
      kind: "skill-authoring-read-result",
      editable: true,
      skill: null,
    }).success,
  ).toBe(false);
  expect(parseReadResponse({ skill: bundleFixture() }).editable).toBe(false);
  expect(parseReadResponse({ editable: true, skill: bundleFixture() }).editable).toBe(true);
});

function bundleFixture() {
  const file = {
    content: "Teach one idea.",
    path: "SKILL.md",
    sizeBytes: encoder.encode("Teach one idea.").byteLength,
  };
  return {
    compatibility: null,
    criteria: [],
    description: "Testing",
    digest,
    files: [file],
    id: "teacher/t1/testing",
    kind: "didactic" as const,
    license: null,
    name: "testing",
    source: "teacher" as const,
  };
}

it("returns canonical personal skills with distinct result discriminators", () => {
  const validated = parseValidatedResponse();
  expect(validated.skill.source).toBe("teacher");
  expect(
    SkillAuthoringSaveResponseSchema.parse({ ...validated, kind: "skill-authoring-saved" }).kind,
  ).toBe("skill-authoring-saved");
  expect(
    SkillAuthoringCopyResponseSchema.parse({ ...validated, kind: "skill-authoring-copied" }).kind,
  ).toBe("skill-authoring-copied");
  for (const [schema, kind] of [
    [SkillAuthoringValidateResponseSchema, "skill-authoring-saved"],
    [SkillAuthoringSaveResponseSchema, "skill-authoring-validated"],
    [SkillAuthoringCopyResponseSchema, "skill-authoring-read-result"],
  ] as const) {
    expect(schema.safeParse({ ...validated, kind }).success).toBe(false);
  }
  const bundled = { ...validated.skill, source: "marea", id: "marea/testing" };
  expect(() =>
    SkillAuthoringValidateResponseSchema.parse({ ...validated, skill: bundled }),
  ).toThrow("Authoring results must have teacher provenance.");
  expect(
    SkillAuthoringValidateResponseSchema.safeParse({ ...validated, extra: true }).success,
  ).toBe(false);
  expect(
    SkillAuthoringValidateResponseSchema.safeParse({ ...validated, skill: null }).success,
  ).toBe(false);
  expect(
    SkillAuthoringValidateResponseSchema.safeParse({
      ...validated,
      skill: { ...validated.skill, files: [] },
    }).success,
  ).toBe(false);
});

it("keeps drafts complete without runtime mutation", () => {
  const parsed = SkillAuthoringDraftSchema.parse(draftFixture());
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.files)).toBe(true);
  const draft: SkillAuthoringDraft = {
    files: [{ content: "x", path: "SKILL.md" }],
    kind: "didactic",
    slug: "testing",
  };
  expect(draft.files.length).toBe(1);
  expect(SkillAuthoringValidateRequestSchema.safeParse(parseValidateRequest()).success).toBe(true);
  expect(classId).toBe("class:one");
  expect(digest.startsWith("sha256:")).toBe(true);
});
