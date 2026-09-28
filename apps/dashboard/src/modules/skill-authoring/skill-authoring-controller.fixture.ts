import { vi } from "vitest";

import type { SkillAuthoringDraft } from "@marea/protocol";

import type {
  SkillAuthoringClient,
  SkillAuthoringClientFailure,
} from "./skill-authoring-contracts.js";
import { SkillAuthoringController } from "./skill-authoring-controller.js";
import {
  skillAuthoringClientFixture,
  skillMissingReadFixture,
  skillReadFixture,
} from "./skill-authoring.fixture.js";

export function skillAuthoringFailure(
  code: SkillAuthoringClientFailure["code"],
): SkillAuthoringClientFailure {
  return Object.assign(new Error(code), { code });
}

export function setupSkillAuthoringController() {
  const base = skillAuthoringClientFixture();
  const client = {
    classes: vi.fn((after: string | null, signal: AbortSignal) => base.classes(after, signal)),
    catalog: vi.fn((classId: string, after: string | null, signal: AbortSignal) =>
      base.catalog(classId, after, signal),
    ),
    readPersonal: vi.fn((classId: string, slug: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return slug === "testing"
        ? Promise.resolve(skillReadFixture)
        : Promise.resolve({ ...skillMissingReadFixture, classId });
    }),
    readCatalog: vi.fn((classId: string, skillId: string, signal: AbortSignal) =>
      base.readCatalog(classId, skillId, signal),
    ),
    validate: vi.fn((classId: string, draft: SkillAuthoringDraft, signal: AbortSignal) =>
      base.validate(classId, draft, signal),
    ),
    save: vi.fn(
      (classId: string, draft: SkillAuthoringDraft, digest: string | null, signal: AbortSignal) =>
        base.save(classId, draft, digest, signal),
    ),
    copy: vi.fn(
      (classId: string, source: string, digest: string, slug: string, signal: AbortSignal) =>
        base.copy(classId, source, digest, slug, signal),
    ),
  } satisfies SkillAuthoringClient;
  const changed = vi.fn();
  return {
    client,
    mocks: client,
    changed,
    controller: new SkillAuthoringController(client, changed),
  };
}
