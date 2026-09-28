import { type SkillAuthoringDraft, type SkillAuthoringReadResponse } from "@marea/protocol";

import type { SkillAuthoringState as DashboardSkillAuthoringState } from "./skill-authoring-contracts.js";
import {
  cloneDraft,
  draftFromBundle,
  isAbortError,
  newSkillDraft,
  problemOf,
} from "./skill-authoring-state.boundary.js";

export interface SkillAuthoringStateAdoption {
  readonly baseline: SkillAuthoringDraft | null;
  readonly patch: Partial<DashboardSkillAuthoringState>;
}

export function classifySkillAuthoringError(
  error: Error,
  kind: "validate" | "write" | undefined,
  preserveWriteProblem: boolean,
  currentProblem: DashboardSkillAuthoringState["problem"],
): DashboardSkillAuthoringState["problem"] {
  if (kind === "write" && isAbortError(error)) return "uncertain";
  if (preserveWriteProblem && (currentProblem === "conflict" || currentProblem === "uncertain")) {
    return currentProblem;
  }
  return problemOf(error, kind);
}

export function adoptSkillAuthoringRead(
  classId: string,
  slug: string,
  read: SkillAuthoringReadResponse,
): SkillAuthoringStateAdoption {
  if (read.skill === null) {
    const draft = newSkillDraft(slug);
    return {
      baseline: cloneDraft(draft),
      patch: {
        classId,
        selectedSkillId: null,
        personalSlug: slug,
        loadedBundle: null,
        editable: true,
        draft,
        dirty: false,
        validation: null,
        problem: null,
        recovery: null,
      },
    };
  }
  const editable = read.editable && read.skill.source === "teacher";
  const draft = editable ? draftFromBundle(read.skill) : null;
  return {
    baseline: draft === null ? null : cloneDraft(draft),
    patch: {
      classId,
      selectedSkillId: null,
      personalSlug: read.skill.name,
      loadedBundle: read.skill,
      editable,
      draft,
      dirty: false,
      validation: null,
      problem: null,
      recovery: null,
    },
  };
}

export function adoptSkillAuthoringCatalogRead(
  classId: string,
  skillId: string,
  read: SkillAuthoringReadResponse,
): SkillAuthoringStateAdoption {
  if (read.skill === null) {
    return {
      baseline: null,
      patch: {
        classId,
        selectedSkillId: skillId,
        personalSlug: null,
        loadedBundle: null,
        editable: false,
        draft: null,
        dirty: false,
        validation: null,
        problem: null,
        recovery: null,
      },
    };
  }
  if (!read.editable || read.skill.source !== "teacher") {
    return {
      baseline: null,
      patch: {
        classId,
        selectedSkillId: skillId,
        personalSlug: null,
        loadedBundle: read.skill,
        editable: false,
        draft: null,
        dirty: false,
        validation: null,
        problem: null,
        recovery: null,
      },
    };
  }
  const adoption = adoptSkillAuthoringRead(classId, read.skill.name, read);
  return {
    baseline: adoption.baseline,
    patch: { ...adoption.patch, selectedSkillId: skillId },
  };
}

export function adoptSkillAuthoringBundle(
  bundle: NonNullable<SkillAuthoringReadResponse["skill"]>,
): SkillAuthoringStateAdoption {
  const draft = draftFromBundle(bundle);
  return {
    baseline: cloneDraft(draft),
    patch: {
      selectedSkillId: null,
      personalSlug: bundle.name,
      loadedBundle: bundle,
      editable: true,
      draft,
      dirty: false,
      validation: null,
      problem: null,
      recovery: null,
      pendingTarget: null,
    },
  };
}
