import {
  Sha256DigestSchema,
  SkillIdSchema,
  TeachingCatalogEntrySchema,
  TeachingSettingsSchema,
  type TeachingCatalogEntry,
} from "@marea/protocol";
import { vi } from "vitest";

import type { TeachingActions } from "./teaching-contracts.js";
import { teachingSettingsFixture, teachingStateFixture } from "./teaching.fixture.js";

export const TEACHING_DIGEST = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
export const TEACHING_STALE_DIGEST = Sha256DigestSchema.parse(`sha256:${"b".repeat(64)}`);

export function teachingSkillFixture(
  id: string,
  name: string,
  kind: "didactic" | "evaluation",
  digest = TEACHING_DIGEST,
): TeachingCatalogEntry {
  return TeachingCatalogEntrySchema.parse({
    id,
    name,
    description:
      "A deliberately long teaching description used to check wrapping, overflow behaviour and realistic catalog copy in the teacher configuration view.",
    kind,
    source: id.startsWith("marea/") ? "marea" : id.startsWith("center/") ? "center" : "teacher",
    digest,
    compatibility: null,
  });
}

export const TEACHING_CATALOG_FIXTURE: readonly TeachingCatalogEntry[] = [
  teachingSkillFixture(SkillIdSchema.parse("marea/guided-inquiry"), "guided-inquiry", "didactic"),
  teachingSkillFixture(
    SkillIdSchema.parse("teacher/alice/exercise-lab"),
    "exercise-lab",
    "didactic",
    TEACHING_STALE_DIGEST,
  ),
  teachingSkillFixture(
    SkillIdSchema.parse("center/north/laboratory-rubric"),
    "laboratory-rubric",
    "evaluation",
  ),
];

const TEACHING_MULTILINE_INSTRUCTIONS = {
  format: "complete-mode",
  tutoring: "Start from the failed boundary test.\nAsk for one hypothesis before revealing hints.",
  free: "Support the project without taking over.\nKeep tool use visible to the student.",
};

export function teachingDraftFixture(
  patch: Partial<{
    agentMode: "tutoring" | "free";
    automaticEvaluation: boolean;
  }> = {},
) {
  return TeachingSettingsSchema.parse({
    ...teachingSettingsFixture,
    classInstructions: TEACHING_MULTILINE_INSTRUCTIONS,
    ...patch,
  });
}

export function teachingSelectedFixture(digest = TEACHING_DIGEST) {
  return TeachingSettingsSchema.parse({
    ...teachingDraftFixture(),
    selection: {
      didactic: [{ id: SkillIdSchema.parse("marea/guided-inquiry"), digest }],
      evaluation: [
        { id: SkillIdSchema.parse("center/north/laboratory-rubric"), digest: TEACHING_DIGEST },
      ],
    },
    automaticEvaluation: true,
  });
}

export function teachingStaleSelectionFixture() {
  return TeachingSettingsSchema.parse({
    ...teachingSelectedFixture(),
    selection: {
      didactic: [
        { id: SkillIdSchema.parse("teacher/alice/exercise-lab"), digest: TEACHING_DIGEST },
      ],
      evaluation: [],
    },
    automaticEvaluation: false,
  });
}

export function teachingActionsFixture(): TeachingActions {
  return {
    loadClasses: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    selectClass: vi.fn<(classId: string) => Promise<void>>().mockResolvedValue(undefined),
    confirmClassSwitch: vi.fn<(discard: boolean) => Promise<void>>().mockResolvedValue(undefined),
    edit: vi.fn<(settings: Parameters<TeachingActions["edit"]>[0]) => void>(),
    save: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    acceptReload: vi.fn<() => void>(),
  };
}

export function teachingViewPropertiesFixture(
  actions: TeachingActions = teachingActionsFixture(),
  statePatch: Parameters<typeof teachingStateFixture>[0] = {},
) {
  return {
    locale: "en" as const,
    state: teachingStateFixture(statePatch),
    controller: actions,
  };
}
