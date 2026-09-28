import { describe, expect, it } from "vitest";

import {
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringSaveResponseSchema,
  TeachingCatalogResponseSchema,
  TeachingClassesResponseSchema,
} from "@marea/protocol";

import {
  skillAuthoringDraftFixture,
  skillAuthoringStateFixture,
  skillCatalogFixture,
  skillClassId,
  skillCopiedFixture,
  skillMissingReadFixture,
  skillReadFixture,
  skillSavedFixture,
  skillValidatedFixture,
} from "./skill-authoring.fixture.js";
import {
  setupSkillAuthoringController as setup,
  skillAuthoringFailure as failure,
} from "./skill-authoring-controller.fixture.js";

const OTHER_CLASS = "class:two";
const DIGEST = `sha256:${"b".repeat(64)}`;
const EDITED_DIDACTIC = {
  ...skillAuthoringDraftFixture,
  files: [{ path: "SKILL.md", content: "Updated teaching." }],
};
const EDITED_EVALUATION = {
  ...EDITED_DIDACTIC,
  kind: "evaluation" as const,
};
const PERSONAL_SKILL = skillReadFixture.skill;
if (PERSONAL_SKILL === null) throw new Error("The fixture must contain a personal skill.");

describe("skill authoring state controller", () => {
  it("starts with an immutable empty state and loads deduplicated class pages", async () => {
    const { controller, mocks, changed } = setup();
    expect(controller.state).toEqual(
      skillAuthoringStateFixture({
        busy: false,
        catalog: [],
        catalogLoaded: false,
        classes: [],
        classesLoaded: false,
        classId: null,
        draft: null,
        editable: false,
        loadedBundle: null,
        personalSlug: null,
        selectedSkillId: null,
        validation: null,
      }),
    );
    expect(Object.isFrozen(controller.state)).toBe(true);
    mocks.classes
      .mockResolvedValueOnce(
        TeachingClassesResponseSchema.parse({
          protocolVersion: "0.1",
          requestId: "request:classes",
          kind: "teaching-classes-response",
          classes: [
            { classId: skillClassId, displayName: "Physics" },
            { classId: skillClassId, displayName: "Duplicate" },
          ],
          nextAfterClassId: skillClassId,
        }),
      )
      .mockResolvedValueOnce(
        TeachingClassesResponseSchema.parse({
          protocolVersion: "0.1",
          requestId: "request:classes-2",
          kind: "teaching-classes-response",
          classes: [{ classId: OTHER_CLASS, displayName: "Chemistry" }],
          nextAfterClassId: OTHER_CLASS,
        }),
      )
      .mockResolvedValueOnce(
        TeachingClassesResponseSchema.parse({
          protocolVersion: "0.1",
          requestId: "request:classes-3",
          kind: "teaching-classes-response",
          classes: [],
          nextAfterClassId: null,
        }),
      );
    await controller.loadClasses();
    expect(mocks.classes).toHaveBeenNthCalledWith(1, null, expect.any(AbortSignal));
    expect(mocks.classes).toHaveBeenNthCalledWith(2, skillClassId, expect.any(AbortSignal));
    expect(mocks.classes).toHaveBeenNthCalledWith(3, OTHER_CLASS, expect.any(AbortSignal));
    expect(controller.state.classes).toEqual([
      { classId: skillClassId, displayName: "Physics" },
      { classId: OTHER_CLASS, displayName: "Chemistry" },
    ]);
    expect(controller.state.classesLoaded).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(controller.state);
  });

  it("selects classes, paginates catalog pages, and rejects non-advancing cursors", async () => {
    const { controller, mocks } = setup();
    mocks.catalog
      .mockResolvedValueOnce(
        TeachingCatalogResponseSchema.parse({
          ...skillCatalogFixture,
          nextAfterSkillId: "marea/bundled",
        }),
      )
      .mockResolvedValueOnce(
        TeachingCatalogResponseSchema.parse({
          ...skillCatalogFixture,
          skills: [...skillCatalogFixture.skills, ...skillCatalogFixture.skills],
          nextAfterSkillId: null,
        }),
      );
    await controller.selectClass(skillClassId);
    expect(controller.state).toMatchObject({
      classId: skillClassId,
      catalogLoaded: true,
      catalog: skillCatalogFixture.skills,
      draft: null,
      selectedSkillId: null,
    });
    expect(mocks.catalog).toHaveBeenNthCalledWith(1, skillClassId, null, expect.any(AbortSignal));
    expect(mocks.catalog).toHaveBeenNthCalledWith(
      2,
      skillClassId,
      "marea/bundled",
      expect.any(AbortSignal),
    );

    mocks.catalog.mockResolvedValueOnce(
      TeachingCatalogResponseSchema.parse({
        ...skillCatalogFixture,
        nextAfterSkillId: "marea/bundled",
      }),
    );
    mocks.catalog.mockResolvedValueOnce(
      TeachingCatalogResponseSchema.parse({
        ...skillCatalogFixture,
        nextAfterSkillId: "marea/bundled",
      }),
    );
    await controller.loadCatalog(skillClassId);
    expect(controller.state).toMatchObject({ catalog: [], catalogLoaded: false, problem: "load" });

    mocks.catalog.mockResolvedValueOnce(TeachingCatalogResponseSchema.parse(skillCatalogFixture));
    await controller.loadCatalog(skillClassId);
    expect(controller.state).toMatchObject({ catalogLoaded: true, problem: null });

    mocks.classes.mockResolvedValue(
      TeachingClassesResponseSchema.parse({
        protocolVersion: "0.1",
        requestId: "request:classes",
        kind: "teaching-classes-response",
        classes: [],
        nextAfterClassId: skillClassId,
      }),
    );
    await controller.loadClasses();
    expect(controller.state.problem).toBe("load");
    mocks.classes.mockResolvedValueOnce(
      TeachingClassesResponseSchema.parse({
        protocolVersion: "0.1",
        requestId: "request:classes-recovery",
        kind: "teaching-classes-response",
        classes: [],
        nextAfterClassId: null,
      }),
    );
    await controller.loadClasses();
    expect(controller.state.problem).toBe(null);
  });

  it("opens read-only catalog skills and missing personal drafts", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.selectSkill("marea/bundled");
    expect(controller.state).toMatchObject({
      selectedSkillId: "marea/bundled",
      personalSlug: null,
      loadedBundle: PERSONAL_SKILL,
      editable: false,
      draft: null,
    });
    await controller.saveDraft(DIGEST);
    expect(mocks.save).not.toHaveBeenCalled();

    mocks.readCatalog.mockResolvedValueOnce(skillMissingReadFixture);
    await controller.selectSkill("marea/missing");
    expect(controller.state).toMatchObject({
      selectedSkillId: "marea/missing",
      personalSlug: null,
      editable: false,
      draft: null,
      loadedBundle: null,
    });

    await controller.startPersonalDraft("new-skill");
    expect(controller.state).toMatchObject({
      personalSlug: "new-skill",
      selectedSkillId: null,
      loadedBundle: null,
      editable: true,
      draft: {
        kind: "didactic",
        slug: "new-skill",
        files: [{ path: "SKILL.md", content: "" }],
      },
      dirty: false,
    });
    const emptyDraft = controller.state.draft;
    if (emptyDraft === null) throw new Error("Expected a missing-skill draft.");
    controller.editDraft(emptyDraft);
    expect(controller.state.dirty).toBe(false);
    controller.editDraft(EDITED_EVALUATION);
    expect(controller.state).toMatchObject({
      dirty: true,
      validation: null,
      draft: EDITED_EVALUATION,
    });
    mocks.validate.mockResolvedValueOnce(skillValidatedFixture);
    await controller.validateDraft();
    expect(controller.state.validation).toEqual(skillValidatedFixture);
  });

  it("compares edits against the defensive sentinel when the baseline is missing", async () => {
    const { controller } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    Reflect.set(controller, "baselineDraft", null);

    controller.editDraft({
      kind: "didactic",
      slug: "testing",
      files: [{ path: "SKILL.md", content: "Changed without a baseline" }],
    });
    expect(controller.state.dirty).toBe(true);

    controller.editDraft({
      kind: "didactic",
      slug: "__missing_baseline__",
      files: [],
    });

    expect(controller.state.dirty).toBe(false);
  });

  it("saves didactic and evaluation drafts using only the loaded digest", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_EVALUATION);
    mocks.save.mockResolvedValueOnce(skillSavedFixture);
    await controller.saveDraft(DIGEST);
    expect(mocks.save).toHaveBeenLastCalledWith(
      skillClassId,
      EDITED_EVALUATION,
      skillReadFixture.skill?.digest,
      expect.any(AbortSignal),
    );
    expect(controller.state).toMatchObject({
      loadedBundle: skillSavedFixture.skill,
      personalSlug: skillSavedFixture.skill.name,
      dirty: false,
      validation: null,
      problem: null,
    });

    controller.editDraft({ ...EDITED_EVALUATION, slug: "saved" });
    mocks.save.mockResolvedValueOnce(
      SkillAuthoringSaveResponseSchema.parse({
        ...skillSavedFixture,
        skill: { ...skillSavedFixture.skill, name: "saved", id: "teacher/t1/saved" },
      }),
    );
    await controller.saveDraft(DIGEST);
    expect(mocks.save.mock.calls.at(-1)?.[2]).toBe(null);
  });

  it("uses the loaded personal digest, validates locally, and blocks failed writes", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);
    mocks.save.mockResolvedValueOnce(
      SkillAuthoringSaveResponseSchema.parse({ ...skillSavedFixture, skill: PERSONAL_SKILL }),
    );
    await controller.saveDraft(DIGEST);
    expect(mocks.save.mock.calls[0]?.[2]).toBe(PERSONAL_SKILL.digest);

    controller.editDraft(EDITED_DIDACTIC);
    mocks.save.mockRejectedValueOnce(failure("conflict"));
    await controller.saveDraft(null);
    expect(controller.state).toMatchObject({
      problem: "conflict",
      dirty: true,
      draft: EDITED_DIDACTIC,
    });
    controller.editDraft(EDITED_EVALUATION);
    expect(controller.state.draft).toEqual(EDITED_DIDACTIC);
    await controller.saveDraft(null);
    expect(mocks.save).toHaveBeenCalledTimes(2);

    mocks.readPersonal.mockResolvedValueOnce(skillReadFixture);
    await controller.reload();
    expect(controller.state).toMatchObject({
      recovery: skillReadFixture,
      problem: "conflict",
      dirty: true,
    });
    controller.acceptReadback();
    expect(controller.state).toMatchObject({
      recovery: null,
      problem: null,
      dirty: false,
      draft: skillAuthoringDraftFixture,
    });
  });

  it("preserves a draft on uncertain copy and recovers the destination slug", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);
    mocks.copy.mockRejectedValueOnce(failure("uncertain"));
    await controller.copySkill("marea/bundled", skillSavedFixture.skill.digest, "copied");
    expect(controller.state).toMatchObject({
      problem: "uncertain",
      draft: EDITED_DIDACTIC,
      dirty: true,
    });
    await controller.copySkill("marea/bundled", skillSavedFixture.skill.digest, "copied");
    expect(mocks.copy).toHaveBeenCalledOnce();

    mocks.readPersonal.mockResolvedValueOnce(
      SkillAuthoringReadResponseSchema.parse({ ...skillMissingReadFixture, classId: skillClassId }),
    );
    await controller.reload();
    expect(mocks.readPersonal).toHaveBeenLastCalledWith(
      "class:one",
      "copied",
      expect.any(AbortSignal),
    );
    expect(controller.state.recovery?.skill).toBeNull();
    controller.acceptReadback();
    expect(controller.state).toMatchObject({
      personalSlug: "copied",
      draft: { slug: "copied" },
      dirty: false,
      recovery: null,
    });

    mocks.copy.mockResolvedValueOnce(SkillAuthoringCopyResponseSchema.parse(skillCopiedFixture));
    await controller.copySkill("marea/bundled", skillSavedFixture.skill.digest, "copied");
    expect(controller.state.loadedBundle).toEqual(skillCopiedFixture.skill);
  });

  it("stages all dirty destinations and only discard confirmation navigates", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);
    await controller.selectClass(OTHER_CLASS);
    expect(controller.state.pendingTarget).toEqual({ kind: "class", classId: OTHER_CLASS });
    controller.acceptReadback();
    await controller.confirmNavigation(false);
    expect(controller.state).toMatchObject({
      pendingTarget: null,
      dirty: true,
      personalSlug: "testing",
    });
    await controller.selectSkill("marea/bundled");
    expect(controller.state.pendingTarget).toEqual({
      kind: "skill",
      classId: skillClassId,
      skillId: "marea/bundled",
    });
    await controller.confirmNavigation(true);
    expect(mocks.readCatalog).toHaveBeenCalledWith(
      skillClassId,
      "marea/bundled",
      expect.any(AbortSignal),
    );
    expect(controller.state.dirty).toBe(false);

    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);
    await controller.startPersonalDraft("another");
    expect(controller.state.pendingTarget).toEqual({
      kind: "personal",
      classId: skillClassId,
      slug: "another",
    });
    await controller.confirmNavigation(true);
    expect(mocks.readPersonal).toHaveBeenLastCalledWith(
      skillClassId,
      "another",
      expect.any(AbortSignal),
    );

    await controller.selectClass(OTHER_CLASS);
    expect(controller.state.classId).toBe(OTHER_CLASS);
    await controller.loadCatalog(OTHER_CLASS);
    expect(controller.state.classId).toBe(OTHER_CLASS);
  });

  it("keeps recovery after a failed reload and adopts clean readbacks explicitly", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    mocks.readPersonal.mockRejectedValueOnce(failure("load"));
    await controller.reload();
    expect(controller.state).toMatchObject({ problem: "load", recovery: null });
    mocks.readPersonal.mockResolvedValueOnce(skillReadFixture);
    await controller.reload();
    expect(controller.state).toMatchObject({ problem: null, recovery: null, dirty: false });
    await controller.reload();
    expect(mocks.readPersonal).toHaveBeenCalledTimes(4);
  });

  it("serializes double clicks, handles aborts as uncertain writes, and suppresses disposal callbacks", async () => {
    const { controller, mocks, changed } = setup();
    await controller.selectClass(skillClassId);
    let finish: ((response: typeof skillReadFixture) => void) | undefined;
    mocks.readPersonal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = controller.startPersonalDraft("testing");
    expect(controller.state.busy).toBe(true);
    await controller.startPersonalDraft("other");
    controller.editDraft(skillAuthoringDraftFixture);
    controller.dispose();
    const updates = changed.mock.calls.length;
    finish?.(skillReadFixture);
    await loading;
    expect(changed).toHaveBeenCalledTimes(updates);
    await controller.loadClasses();
    expect(mocks.classes).not.toHaveBeenCalled();

    const second = setup();
    await second.controller.selectClass(skillClassId);
    await second.controller.startPersonalDraft("testing");
    second.controller.editDraft(EDITED_DIDACTIC);
    second.mocks.save.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    await second.controller.saveDraft(null);
    expect(second.controller.state.problem).toBe("uncertain");
  });
});
