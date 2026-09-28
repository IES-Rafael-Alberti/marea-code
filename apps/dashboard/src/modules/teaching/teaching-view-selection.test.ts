import { TeachingSettingsSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { SkillIdSchema } from "@marea/protocol";
import {
  TEACHING_CATALOG_FIXTURE,
  TEACHING_DIGEST,
  TEACHING_STALE_DIGEST,
  teachingDraftFixture,
  teachingSelectedFixture,
  teachingStaleSelectionFixture,
} from "./teaching-view.fixture.js";
import {
  reviewTeachingSelections,
  withToggledRevision,
  withoutRevision,
} from "./teaching-view-selection.js";

describe("teaching selection review", () => {
  it("marks current, stale and missing selections without rewriting digests", () => {
    const currentDidactic = TEACHING_CATALOG_FIXTURE[0];
    const staleDidactic = TEACHING_CATALOG_FIXTURE[1];
    if (currentDidactic === undefined || staleDidactic === undefined)
      throw new Error("Expected catalog fixture");
    const selected = teachingSelectedFixture();
    const stale = teachingStaleSelectionFixture();
    const missing = {
      ...selected,
      selection: {
        ...selected.selection,
        didactic: [{ id: SkillIdSchema.parse("marea/guided-inquiry"), digest: TEACHING_DIGEST }],
        evaluation: [
          {
            id: SkillIdSchema.parse("center/ghost/removed-method"),
            digest: TEACHING_STALE_DIGEST,
          },
        ],
      },
    };
    const reviewed = reviewTeachingSelections(selected, TEACHING_CATALOG_FIXTURE);
    expect(reviewed.didactic[0]).toEqual({
      id: "marea/guided-inquiry",
      digest: TEACHING_DIGEST,
      status: "current",
      entry: currentDidactic,
    });
    expect(reviewed.evaluation[0]?.status).toBe("current");
    const staleReviewed = reviewTeachingSelections(stale, TEACHING_CATALOG_FIXTURE);
    expect(staleReviewed.didactic[0]?.status).toBe("stale");
    expect(staleReviewed.didactic[0]?.entry).toBe(staleDidactic);
    const missingReviewed = reviewTeachingSelections(missing, TEACHING_CATALOG_FIXTURE);
    expect(missingReviewed.evaluation[0]).toMatchObject({ status: "missing", entry: null });
    expect(reviewTeachingSelections(selected, [currentDidactic]).available.evaluation).toEqual([]);
  });
});

describe("teaching selection edits", () => {
  const settings = teachingSelectedFixture();

  it("toggles selections, replaces stale identities and always deactivates evaluation without exactly one method", () => {
    const didactic = settings.selection.didactic[0];
    if (didactic === undefined) throw new Error("Expected didactic fixture");
    const added = withToggledRevision(settings, "didactic", {
      id: "teacher/alice/exercise-lab",
      digest: TEACHING_STALE_DIGEST,
    });
    expect(added.selection.didactic).toHaveLength(2);
    expect(added.automaticEvaluation).toBe(true);
    const removed = withToggledRevision(settings, "didactic", didactic);
    expect(removed.selection.didactic).toEqual([]);
    const stale = teachingStaleSelectionFixture();
    const staleSelection = stale.selection.didactic[0];
    if (staleSelection === undefined) throw new Error("Expected stale fixture");
    const replaced = withToggledRevision(stale, "didactic", {
      id: staleSelection.id,
      digest: TEACHING_STALE_DIGEST,
    });
    expect(replaced.selection.didactic).toEqual([
      { id: staleSelection.id, digest: TEACHING_STALE_DIGEST },
    ]);
    const evaluation = settings.selection.evaluation[0];
    if (evaluation === undefined) throw new Error("Expected evaluation fixture");
    const evaluationRemoved = withToggledRevision(settings, "evaluation", evaluation);
    expect(evaluationRemoved.selection.evaluation).toEqual([]);
    expect(evaluationRemoved.automaticEvaluation).toBe(false);
  });

  it("removes selections by identity and keeps evaluation prerequisites safe", () => {
    const didactic = settings.selection.didactic[0];
    if (didactic === undefined) throw new Error("Expected didactic fixture");
    const removedDidactic = withoutRevision(settings, "didactic", didactic.id);
    expect(removedDidactic.selection.didactic).toEqual([]);
    expect(removedDidactic.automaticEvaluation).toBe(true);
    const removedEvaluation = withoutRevision(
      settings,
      "evaluation",
      "center/north/laboratory-rubric",
    );
    expect(removedEvaluation.selection.evaluation).toEqual([]);
    expect(removedEvaluation.automaticEvaluation).toBe(false);
    const untouched = withoutRevision(settings, "didactic", "marea/absent-skill");
    expect(untouched).toEqual(settings);
  });
});

describe("teaching selection invariants", () => {
  it("replaces stale digests in place without deactivating a still-valid opt-in", () => {
    const reselected = withToggledRevision(teachingSelectedFixture(), "evaluation", {
      id: "center/north/laboratory-rubric",
      digest: TEACHING_STALE_DIGEST,
    });
    expect(reselected.selection.evaluation).toEqual([
      { id: "center/north/laboratory-rubric", digest: TEACHING_STALE_DIGEST },
    ]);
    expect(reselected.automaticEvaluation).toBe(true);
  });

  it("adds same-digest selections by identity and keeps siblings on exact removal", () => {
    const sameDigest = TeachingSettingsSchema.parse({
      ...teachingDraftFixture(),
      selection: {
        didactic: [
          { id: SkillIdSchema.parse("teacher/alice/exercise-lab"), digest: TEACHING_DIGEST },
        ],
        evaluation: [],
      },
    });
    const added = withToggledRevision(sameDigest, "didactic", {
      id: SkillIdSchema.parse("marea/guided-inquiry"),
      digest: TEACHING_DIGEST,
    });
    expect(added.selection.didactic).toHaveLength(2);
    const both = TeachingSettingsSchema.parse({
      ...teachingDraftFixture(),
      selection: {
        didactic: [
          { id: SkillIdSchema.parse("marea/guided-inquiry"), digest: TEACHING_DIGEST },
          { id: SkillIdSchema.parse("teacher/alice/exercise-lab"), digest: TEACHING_STALE_DIGEST },
        ],
        evaluation: [],
      },
    });
    const removed = withToggledRevision(both, "didactic", {
      id: SkillIdSchema.parse("marea/guided-inquiry"),
      digest: TEACHING_DIGEST,
    });
    expect(removed.selection.didactic).toEqual([
      { id: SkillIdSchema.parse("teacher/alice/exercise-lab"), digest: TEACHING_STALE_DIGEST },
    ]);
  });
});
