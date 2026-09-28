import {
  SaveTeachingConfigurationResponseSchema,
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringSaveResponseSchema,
  SkillAuthoringValidateResponseSchema,
  TeachingCatalogResponseSchema,
  TeachingClassesResponseSchema,
  TeachingConfigurationResponseSchema,
  type SkillAuthoringDraft,
  type TeachingSettings,
} from "@marea/protocol";

import type { SkillAuthoringClient } from "./modules/skill-authoring/skill-authoring-contracts.js";
import type { TeachingClient } from "./modules/teaching/teaching-contracts.js";

export const WORKFLOW_CLASS_A = "class:one";
export const WORKFLOW_CLASS_B = "class:two";
export const WORKFLOW_DIGEST_A = `sha256:${"a".repeat(64)}`;
export const WORKFLOW_DIGEST_B = `sha256:${"b".repeat(64)}`;
export const WORKFLOW_DIGEST_C = `sha256:${"c".repeat(64)}`;

export function workflowSettings(instruction = "Original teaching draft."): TeachingSettings {
  return {
    agentMode: "tutoring",
    classInstructions: { tutoring: instruction, free: "Free draft." },
    selection: { didactic: [], evaluation: [] },
    automaticEvaluation: false,
  };
}

export function workflowDraft(slug = "testing", content = "Teach one idea."): SkillAuthoringDraft {
  return { kind: "didactic", slug, files: [{ path: "SKILL.md", content }] };
}

function bundle(id: string, slug: string, digest: string, content: string) {
  return {
    compatibility: null,
    criteria: [],
    description: `Workflow ${slug}`,
    digest,
    files: [{ content, path: "SKILL.md", sizeBytes: content.length }],
    id,
    kind: "didactic" as const,
    license: null,
    name: slug,
    source: id.startsWith("teacher/") ? ("teacher" as const) : ("marea" as const),
  };
}

export function workflowTransports() {
  const configurations = new Map([
    [WORKFLOW_CLASS_A, { version: "revision:one", settings: workflowSettings() }],
    [WORKFLOW_CLASS_B, { version: "revision:two", settings: workflowSettings("B original") }],
  ]);
  const bundles = new Map([
    [
      "teacher/alice/testing",
      bundle("teacher/alice/testing", "testing", WORKFLOW_DIGEST_A, "Teach one idea."),
    ],
    [
      "teacher/alice/other",
      bundle("teacher/alice/other", "other", WORKFLOW_DIGEST_C, "Teach chemistry."),
    ],
    ["marea/bundled", bundle("marea/bundled", "bundled", WORKFLOW_DIGEST_A, "Bundled source.")],
  ]);
  const catalogEntries = new Map([
    [WORKFLOW_CLASS_A, ["teacher/alice/testing", "marea/bundled"]],
    [WORKFLOW_CLASS_B, ["teacher/alice/other"]],
  ]);
  const teachingCalls: string[] = [];
  const authoringCalls: string[] = [];
  const failures = { teaching: new Map<string, Error>(), authoring: new Map<string, Error>() };
  const late: { teaching?: Promise<never>; authoring?: Promise<never> } = {};
  const classes = TeachingClassesResponseSchema.parse({
    kind: "teaching-classes-response",
    protocolVersion: "0.1",
    requestId: "workflow-classes",
    classes: [
      { classId: WORKFLOW_CLASS_A, displayName: "Physics" },
      { classId: WORKFLOW_CLASS_B, displayName: "Chemistry" },
    ],
    nextAfterClassId: null,
  });
  const catalog = (classId: string) =>
    TeachingCatalogResponseSchema.parse({
      kind: "teaching-catalog-response",
      protocolVersion: "0.1",
      requestId: "workflow-catalog",
      classId,
      skills: (catalogEntries.get(classId) ?? []).map((id) => {
        const value = bundles.get(id);
        if (value === undefined) throw new Error(`missing fixture bundle ${id}`);
        return {
          id,
          name: value.name,
          description: value.description,
          kind: value.kind,
          source: value.source,
          digest: value.digest,
          compatibility: null,
        };
      }),
      nextAfterSkillId: null,
    });
  const teaching: TeachingClient = {
    classes: async (_after, signal) => {
      await Promise.resolve();
      teachingCalls.push("classes");
      signal.throwIfAborted();
      return classes;
    },
    read: async (classId, signal) => {
      teachingCalls.push(`read:${classId}`);
      if (late.teaching) return late.teaching;
      signal.throwIfAborted();
      const failure = failures.teaching.get("read");
      if (failure) throw failure;
      return TeachingConfigurationResponseSchema.parse({
        kind: "teaching-configuration-response",
        protocolVersion: "0.1",
        requestId: "workflow-read",
        classId,
        configuration: configurations.get(classId) ?? null,
        operatorReady: true,
      });
    },
    catalog: async (classId, _after, signal) => {
      await Promise.resolve();
      teachingCalls.push(`catalog:${classId}`);
      signal.throwIfAborted();
      return catalog(classId);
    },
    save: async (classId, expected, settings, signal) => {
      await Promise.resolve();
      teachingCalls.push(`save:${classId}:${expected ?? "null"}`);
      signal.throwIfAborted();
      const failure = failures.teaching.get("save");
      if (failure) throw failure;
      const version =
        expected === null
          ? "revision:first"
          : `revision:${classId === WORKFLOW_CLASS_A ? "saved-a" : "saved-b"}`;
      configurations.set(classId, { version, settings });
      return SaveTeachingConfigurationResponseSchema.parse({
        kind: "teaching-configuration-saved",
        protocolVersion: "0.1",
        requestId: "workflow-save",
        classId,
        configuration: { version, settings },
      });
    },
  };
  const authoring: SkillAuthoringClient = {
    classes: async (_after, signal) => {
      await Promise.resolve();
      authoringCalls.push("classes");
      signal.throwIfAborted();
      return classes;
    },
    catalog: async (classId, _after, signal) => {
      await Promise.resolve();
      authoringCalls.push(`catalog:${classId}`);
      signal.throwIfAborted();
      return catalog(classId);
    },
    readCatalog: async (classId, skillId, signal) => {
      await Promise.resolve();
      authoringCalls.push(`readCatalog:${classId}:${skillId}`);
      signal.throwIfAborted();
      const skill = bundles.get(skillId) ?? null;
      return SkillAuthoringReadResponseSchema.parse({
        kind: "skill-authoring-read-result",
        protocolVersion: "0.1",
        requestId: "workflow-authoring-read",
        classId,
        skill,
        editable: skill?.source === "teacher",
      });
    },
    readPersonal: async (classId, slug, signal) => {
      await Promise.resolve();
      authoringCalls.push(`readPersonal:${classId}:${slug}`);
      if (late.authoring) return late.authoring;
      signal.throwIfAborted();
      const skill = bundles.get(`teacher/alice/${slug}`) ?? null;
      return SkillAuthoringReadResponseSchema.parse({
        kind: "skill-authoring-read-result",
        protocolVersion: "0.1",
        requestId: "workflow-personal-read",
        classId,
        skill,
        editable: skill !== null,
      });
    },
    validate: async (classId, draft, signal) => {
      await Promise.resolve();
      authoringCalls.push("validate");
      signal.throwIfAborted();
      const skill = bundle(
        `teacher/alice/${draft.slug}`,
        draft.slug,
        WORKFLOW_DIGEST_B,
        draft.files[0]?.content ?? "",
      );
      return SkillAuthoringValidateResponseSchema.parse({
        kind: "skill-authoring-validated",
        protocolVersion: "0.1",
        requestId: "workflow-validate",
        classId,
        skill,
      });
    },
    save: async (classId, draft, expected, signal) => {
      await Promise.resolve();
      authoringCalls.push(`save:${classId}:${expected ?? "null"}`);
      signal.throwIfAborted();
      const failure = failures.authoring.get("save");
      if (failure) throw failure;
      const id = `teacher/alice/${draft.slug}`;
      const saved = bundle(id, draft.slug, WORKFLOW_DIGEST_B, draft.files[0]?.content ?? "");
      bundles.set(id, saved);
      if (!(catalogEntries.get(classId) ?? []).includes(id)) catalogEntries.get(classId)?.push(id);
      return SkillAuthoringSaveResponseSchema.parse({
        kind: "skill-authoring-saved",
        protocolVersion: "0.1",
        requestId: "workflow-authoring-save",
        classId,
        skill: saved,
      });
    },
    copy: async (classId, sourceSkillId, sourceDigest, slug, signal) => {
      await Promise.resolve();
      authoringCalls.push(`copy:${classId}:${sourceSkillId}:${sourceDigest}:${slug}`);
      signal.throwIfAborted();
      const source = bundles.get(sourceSkillId);
      if (source?.digest !== sourceDigest) throw new Error("source mismatch");
      const copied = bundle(
        `teacher/alice/${slug}`,
        slug,
        WORKFLOW_DIGEST_B,
        source.files[0]?.content ?? "",
      );
      bundles.set(copied.id, copied);
      catalogEntries.get(classId)?.push(copied.id);
      return SkillAuthoringCopyResponseSchema.parse({
        kind: "skill-authoring-copied",
        protocolVersion: "0.1",
        requestId: "workflow-copy",
        classId,
        skill: copied,
      });
    },
  };
  return {
    teaching,
    authoring,
    teachingCalls,
    authoringCalls,
    failures,
    late,
    configurations,
    bundles,
    catalogEntries,
  };
}
