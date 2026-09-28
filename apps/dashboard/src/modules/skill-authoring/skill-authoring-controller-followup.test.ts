import { describe, expect, it } from "vitest";
import { SkillAuthoringReadResponseSchema } from "@marea/protocol";

import {
  skillAuthoringDraftFixture,
  skillClassId,
  skillMissingReadFixture,
  skillReadFixture,
  skillSavedFixture,
} from "./skill-authoring.fixture.js";
import {
  setupSkillAuthoringController as setup,
  skillAuthoringFailure as failure,
} from "./skill-authoring-controller.fixture.js";

const OTHER_CLASS = "class:two";
const EDITED_DIDACTIC = {
  ...skillAuthoringDraftFixture,
  files: [{ path: "SKILL.md", content: "Updated teaching." }],
};

describe("skill authoring controller review regressions", () => {
  it("stages a dirty class change requested through the public catalog loader", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);

    const catalogCalls = mocks.catalog.mock.calls.length;
    await controller.loadCatalog(OTHER_CLASS);

    expect(mocks.catalog).toHaveBeenCalledTimes(catalogCalls);
    expect(controller.state).toMatchObject({
      classId: skillClassId,
      dirty: true,
      draft: EDITED_DIDACTIC,
      pendingTarget: { kind: "class", classId: OTHER_CLASS },
    });

    await controller.confirmNavigation(false);
    expect(controller.state).toMatchObject({
      classId: skillClassId,
      dirty: true,
      pendingTarget: null,
    });
    await controller.loadCatalog(skillClassId);
    expect(controller.state).toMatchObject({
      classId: skillClassId,
      dirty: true,
      draft: EDITED_DIDACTIC,
      pendingTarget: null,
    });
  });

  it("allows an editable teacher catalog result to be edited and saved", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    mocks.readCatalog.mockResolvedValueOnce(skillReadFixture);
    await controller.selectSkill("marea/bundled");

    expect(controller.state).toMatchObject({
      selectedSkillId: "marea/bundled",
      personalSlug: "testing",
      editable: true,
      draft: skillAuthoringDraftFixture,
      dirty: false,
    });

    controller.editDraft(EDITED_DIDACTIC);
    mocks.save.mockResolvedValueOnce(skillSavedFixture);
    await controller.saveDraft(null);

    expect(mocks.save).toHaveBeenCalledWith(
      skillClassId,
      EDITED_DIDACTIC,
      skillReadFixture.skill?.digest,
      expect.any(AbortSignal),
    );
    expect(controller.state).toMatchObject({
      personalSlug: "testing",
      editable: true,
      dirty: false,
      loadedBundle: skillSavedFixture.skill,
    });
  });

  it("recovers an uncertain renamed save at its exact destination", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    const renamed = { ...EDITED_DIDACTIC, slug: "renamed" };
    controller.editDraft(renamed);
    mocks.save.mockRejectedValueOnce(failure("uncertain"));

    await controller.saveDraft(null);
    expect(controller.state).toMatchObject({ problem: "uncertain", draft: renamed, dirty: true });

    mocks.readPersonal.mockResolvedValueOnce({
      ...skillMissingReadFixture,
      classId: skillClassId,
    });
    await controller.reload();
    expect(mocks.readPersonal).toHaveBeenLastCalledWith(
      skillClassId,
      "renamed",
      expect.any(AbortSignal),
    );
    expect(controller.state.recovery?.skill).toBeNull();
    controller.acceptReadback();
    expect(controller.state).toMatchObject({
      personalSlug: "renamed",
      draft: { slug: "renamed" },
      dirty: false,
      recovery: null,
    });
  });

  it("recovers a known failed renamed save with a present destination readback", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    const renamed = { ...EDITED_DIDACTIC, slug: "renamed" };
    controller.editDraft(renamed);
    mocks.save.mockRejectedValueOnce(failure("conflict"));

    await controller.saveDraft(null);
    expect(controller.state.problem).toBe("conflict");
    mocks.readPersonal.mockResolvedValueOnce(
      SkillAuthoringReadResponseSchema.parse({
        ...skillReadFixture,
        skill: {
          ...skillReadFixture.skill,
          id: "teacher/t1/renamed",
          name: "renamed",
        },
      }),
    );
    await controller.reload();
    expect(mocks.readPersonal).toHaveBeenLastCalledWith(
      skillClassId,
      "renamed",
      expect.any(AbortSignal),
    );
    controller.acceptReadback();
    expect(controller.state.personalSlug).toBe("renamed");
    expect(controller.state.loadedBundle?.name).toBe("renamed");
    expect(controller.state.draft?.slug).toBe("renamed");
    expect(controller.state.dirty).toBe(false);
    expect(controller.state.problem).toBe(null);
  });
});
