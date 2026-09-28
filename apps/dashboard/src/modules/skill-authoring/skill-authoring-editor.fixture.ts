import { vi } from "vitest";

import type { SkillAuthoringDraft } from "@marea/protocol";

import { skillAuthoringDraftFixture, skillReadFixture } from "./skill-authoring.fixture.js";
import type { SkillAuthoringEditorProperties } from "./skill-authoring-editor.js";
import { skillAuthoringMessages } from "./skill-authoring-messages.js";
import { skillAuthoringFileExchangeFixture } from "./skill-authoring-view.fixture.js";

const messages = skillAuthoringMessages("en");

export function skillAuthoringEditorPropertiesFixture(
  patch: Partial<SkillAuthoringEditorProperties> = {},
) {
  const edit = vi.fn<(draft: SkillAuthoringDraft) => void>();
  const validate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const save = vi.fn<(digest: string | null) => Promise<void>>().mockResolvedValue(undefined);
  const copy = vi
    .fn<(sourceSkillId: string, sourceDigest: string, slug: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const files = skillAuthoringFileExchangeFixture();
  const properties = {
    blocked: false,
    busy: false,
    copySource: null,
    dirty: true,
    draft: skillAuthoringDraftFixture,
    editable: true,
    expectedDigest: skillReadFixture.skill?.digest ?? null,
    files,
    loadedBundle: skillReadFixture.skill,
    messages,
    validation: null,
    edit,
    validate,
    save,
    copy,
    ...patch,
  } satisfies SkillAuthoringEditorProperties;
  return { copy, edit, files, properties, save, validate };
}
