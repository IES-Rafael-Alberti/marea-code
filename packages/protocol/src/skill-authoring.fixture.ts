import {
  CURRENT_PROTOCOL_VERSION,
  SkillAuthoringCopyRequestSchema,
  SkillAuthoringReadRequestSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringSaveRequestSchema,
  SkillAuthoringValidateRequestSchema,
  SkillAuthoringValidateResponseSchema,
  type SkillAuthoringDraft,
} from "./index.js";

export const classId = "class:one";
const requestId = "request:authoring";
export const digest = `sha256:${"a".repeat(64)}`;

const envelope = { classId, protocolVersion: CURRENT_PROTOCOL_VERSION, requestId };

export function draftFileFixture(patch: Partial<{ path: string; content: string }> = {}): {
  path: string;
  content: string;
} {
  return { content: "Teach one idea.", path: "SKILL.md", ...patch };
}

export function draftFixture(patch: Partial<SkillAuthoringDraft> = {}): {
  kind: SkillAuthoringDraft["kind"];
  slug: SkillAuthoringDraft["slug"];
  files: readonly { path: string; content: string }[];
} {
  return {
    files: [draftFileFixture()],
    kind: "didactic",
    slug: "testing",
    ...patch,
  };
}

export function readRequestFixture(
  patch: Partial<Record<string, string | boolean | null | object>> = {},
): Record<string, string | boolean | null | object> {
  return {
    ...envelope,
    kind: "skill-authoring-read",
    target: { scope: "personal", slug: "testing" },
    ...patch,
  };
}

export function parseReadRequest(
  patch: Partial<Record<string, string | boolean | null | object>> = {},
) {
  return SkillAuthoringReadRequestSchema.parse(readRequestFixture(patch));
}

export function parseValidateRequest(
  patch: Partial<Record<string, string | boolean | null | object>> = {},
) {
  return SkillAuthoringValidateRequestSchema.parse({
    ...envelope,
    draft: draftFixture(),
    kind: "skill-authoring-validate",
    ...patch,
  });
}

export function parseSaveRequest(
  patch: Partial<Record<string, string | boolean | null | object>> = {},
) {
  return SkillAuthoringSaveRequestSchema.parse({
    ...envelope,
    draft: draftFixture(),
    expectedDigest: null,
    kind: "skill-authoring-save",
    ...patch,
  });
}

export function parseCopyRequest(
  patch: Partial<Record<string, string | boolean | null | object>> = {},
) {
  return SkillAuthoringCopyRequestSchema.parse({
    ...envelope,
    kind: "skill-authoring-copy",
    slug: "copied",
    sourceDigest: digest,
    sourceSkillId: "marea/bundled",
    ...patch,
  });
}

export function parseReadResponse(
  patch: Partial<Record<string, string | boolean | null | object>> = {},
) {
  return SkillAuthoringReadResponseSchema.parse({
    ...envelope,
    editable: false,
    kind: "skill-authoring-read-result",
    skill: null,
    ...patch,
  });
}

export function parseValidatedResponse(
  patch: Partial<Record<string, string | boolean | null | object>> = {},
) {
  const content = "Teach one idea.";
  return SkillAuthoringValidateResponseSchema.parse({
    ...envelope,
    kind: "skill-authoring-validated",
    skill: {
      compatibility: null,
      criteria: [],
      description: "Testing",
      digest,
      files: [
        { content, path: "SKILL.md", sizeBytes: new TextEncoder().encode(content).byteLength },
      ],
      id: "teacher/t1/testing",
      kind: "didactic",
      license: null,
      name: "testing",
      source: "teacher",
    },
    ...patch,
  });
}
