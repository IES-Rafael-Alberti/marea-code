/* eslint-disable max-lines */
import { describe, expect, it, vi } from "vitest";

import {
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringReadResponseSchema,
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
} from "./skill-authoring.fixture.js";
import {
  setupSkillAuthoringController as setup,
  skillAuthoringFailure as failure,
} from "./skill-authoring-controller.fixture.js";
import {
  compareBinary,
  copyContext,
  editableDraftContext,
  immutableState,
  isAbortError,
  newSkillDraft,
  problemOf,
  sameDraft,
  validSkillSlug,
} from "./skill-authoring-state.boundary.js";
import {
  readSkillAuthoringCatalog,
  readSkillAuthoringClasses,
} from "./skill-authoring-controller-pagination.js";
import {
  adoptSkillAuthoringCatalogRead,
  adoptSkillAuthoringRead,
  classifySkillAuthoringError,
} from "./skill-authoring-controller-state.js";
import type { SkillAuthoringState } from "./skill-authoring-contracts.js";

const OTHER_CLASS = "class:two";
const EDITED_DIDACTIC = {
  ...skillAuthoringDraftFixture,
  files: [{ path: "SKILL.md", content: "Updated teaching." }],
};

function patchControllerState(
  controller: ReturnType<typeof setup>["controller"],
  patch: Partial<SkillAuthoringState>,
): void {
  Reflect.set(controller, "currentState", immutableState({ ...controller.state, ...patch }));
}

function patchControllerFlag(
  controller: ReturnType<typeof setup>["controller"],
  name: "disposed" | "operationBusy",
  value: boolean,
): void {
  Reflect.set(controller, name, value);
}

function deferredClasses() {
  let finish: (() => void) | undefined;
  const response = TeachingClassesResponseSchema.parse({
    protocolVersion: "0.1",
    requestId: "request:classes",
    kind: "teaching-classes-response",
    classes: [],
    nextAfterClassId: null,
  });
  return {
    implementation: () =>
      new Promise<typeof response>((resolve) => {
        finish = () => {
          resolve(response);
        };
      }),
    finish: () => finish?.(),
  };
}

describe("skill authoring controller guards and recovery", () => {
  it("keeps slug, draft, copy, cursor, and error boundaries exact", () => {
    expect(validSkillSlug("a".repeat(64))).toBe(true);
    expect(validSkillSlug("a".repeat(65))).toBe(false);
    expect(validSkillSlug("alpha-beta")).toBe(true);
    expect(validSkillSlug("alpha")).toBe(true);
    expect(validSkillSlug("alpha beta")).toBe(false);
    expect(validSkillSlug("alpha-beta!")).toBe(false);
    expect(validSkillSlug("-alpha")).toBe(false);
    expect(validSkillSlug("alpha-")).toBe(false);
    expect(validSkillSlug("alpha--beta")).toBe(false);
    expect(validSkillSlug("prefix alpha")).toBe(false);
    expect(validSkillSlug("Bad-Slug")).toBe(false);

    const ready = skillAuthoringStateFixture();
    expect(editableDraftContext(ready, false, false)).toMatchObject({
      classId: skillClassId,
      draft: skillAuthoringDraftFixture,
    });
    const draftBlockers = [
      [true, false, ready],
      [false, true, ready],
      [false, false, { ...ready, editable: false }],
      [false, false, { ...ready, draft: null }],
      [false, false, { ...ready, classId: null }],
      [false, false, { ...ready, pendingTarget: { kind: "class", classId: skillClassId } }],
      [false, false, { ...ready, recovery: skillReadFixture }],
    ] as const;
    for (const [disposed, busy, state] of draftBlockers) {
      expect(editableDraftContext(state, disposed, busy)).toBeNull();
    }

    const validDigest = `sha256:${"b".repeat(64)}`;
    expect(copyContext(ready, false, false, "marea/bundled", validDigest, "copied")).toEqual({
      classId: skillClassId,
    });
    const copyBlockers = [
      [true, false, ready, "marea/bundled", validDigest, "copied"],
      [false, true, ready, "marea/bundled", validDigest, "copied"],
      [false, false, ready, "bad id", validDigest, "copied"],
      [false, false, ready, "marea/bundled", "bad digest", "copied"],
      [false, false, ready, "Bad Slug", validDigest, "copied"],
      [false, false, { ...ready, classId: null }, "marea/bundled", validDigest, "copied"],
      [
        false,
        false,
        { ...ready, pendingTarget: { kind: "class", classId: skillClassId } },
        "marea/bundled",
        validDigest,
        "copied",
      ],
      [
        false,
        false,
        { ...ready, recovery: skillReadFixture },
        "marea/bundled",
        validDigest,
        "copied",
      ],
      [false, false, { ...ready, problem: "conflict" }, "marea/bundled", validDigest, "copied"],
      [false, false, { ...ready, problem: "uncertain" }, "marea/bundled", validDigest, "copied"],
    ] as const;
    for (const [disposed, busy, state, source, digest, slug] of copyBlockers) {
      expect(copyContext(state, disposed, busy, source, digest, slug)).toBeNull();
    }

    expect(compareBinary("a", "a")).toBe(0);
    expect(compareBinary("a", "b")).toBeLessThan(0);
    expect(compareBinary("aa", "a")).toBeGreaterThan(0);
    expect(compareBinary("é", "e")).toBeGreaterThan(0);

    for (const problem of [
      "load",
      "invalid",
      "forbidden",
      "conflict",
      "uncertain",
      "skill-unavailable",
    ] as const) {
      const fallbackKind = problem === "load" ? "validate" : "load";
      expect(problemOf(failure(problem), fallbackKind)).toBe(problem);
    }
    expect(problemOf(new Error("unknown"), "load")).toBe("load");
    expect(problemOf(new Error("unknown"), "validate")).toBe("invalid");
    expect(problemOf(new Error("unknown"), "write")).toBe("uncertain");
    expect(problemOf(Object.assign(new Error(), { code: "not-a-problem" }), "load")).toBe("load");
    expect(problemOf(Object.assign(new Error(), { code: 42 }), "load")).toBe("load");
    expect(sameDraft(skillAuthoringDraftFixture, skillAuthoringDraftFixture)).toBe(true);
    expect(sameDraft(skillAuthoringDraftFixture, EDITED_DIDACTIC)).toBe(false);
    expect(newSkillDraft("new-skill")).toEqual({
      kind: "didactic",
      slug: "new-skill",
      files: [{ path: "SKILL.md", content: "" }],
    });

    const aborted = new DOMException("cancelled", "AbortError");
    expect(classifySkillAuthoringError(aborted, "write", false, null)).toBe("uncertain");
    const abortWithCode = new DOMException("cancelled", "AbortError");
    Object.defineProperty(abortWithCode, "code", { value: "load" });
    expect(classifySkillAuthoringError(abortWithCode, "write", false, null)).toBe("uncertain");
    expect(classifySkillAuthoringError(aborted, "validate", false, null)).toBe("invalid");
    expect(classifySkillAuthoringError(aborted, undefined, false, null)).toBe("load");
    expect(classifySkillAuthoringError(new Error("unknown"), undefined, false, null)).toBe("load");
    expect(classifySkillAuthoringError(new Error("retry"), "write", true, "uncertain")).toBe(
      "uncertain",
    );
    expect(classifySkillAuthoringError(failure("load"), "write", true, "uncertain")).toBe(
      "uncertain",
    );
    expect(classifySkillAuthoringError(failure("invalid"), undefined, false, null)).toBe("invalid");

    const personalSkill = skillReadFixture.skill;
    if (personalSkill === null) throw new Error("Expected a personal skill fixture.");
    const readonlyRead = SkillAuthoringReadResponseSchema.parse({
      ...skillReadFixture,
      editable: true,
      skill: { ...personalSkill, id: "marea/testing", source: "marea" },
    });
    const readonlyAdoption = adoptSkillAuthoringRead(skillClassId, "testing", readonlyRead);
    expect(readonlyAdoption).toMatchObject({
      baseline: null,
      patch: { editable: false, draft: null },
    });
    const editableAdoption = adoptSkillAuthoringRead(skillClassId, "testing", skillReadFixture);
    expect(editableAdoption.baseline).toEqual(skillAuthoringDraftFixture);
    const catalogMissing = adoptSkillAuthoringCatalogRead(
      skillClassId,
      "marea/missing",
      skillMissingReadFixture,
    );
    expect(catalogMissing).toMatchObject({
      baseline: null,
      patch: {
        classId: skillClassId,
        selectedSkillId: "marea/missing",
        loadedBundle: null,
        editable: false,
        draft: null,
        personalSlug: null,
      },
    });
    const catalogReadonly = adoptSkillAuthoringCatalogRead(
      skillClassId,
      "marea/bundled",
      SkillAuthoringReadResponseSchema.parse({
        ...skillReadFixture,
        editable: true,
        skill: { ...personalSkill, name: "bundled", source: "marea", id: "marea/bundled" },
      }),
    );
    expect(catalogReadonly).toMatchObject({
      baseline: null,
      patch: {
        selectedSkillId: "marea/bundled",
        personalSlug: null,
        editable: false,
        draft: null,
      },
    });
    const malformedMissing = {
      ...skillMissingReadFixture,
      editable: true,
    } as typeof skillMissingReadFixture;
    expect(
      adoptSkillAuthoringCatalogRead(skillClassId, "marea/missing", malformedMissing),
    ).toMatchObject({
      patch: { loadedBundle: null, editable: false, draft: null },
    });

    expect(isAbortError(new DOMException("cancelled", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("other", "NetworkError"))).toBe(false);
    expect(isAbortError(Object.assign(new Error(), { name: "AbortError" }))).toBe(false);
  });

  it("enforces pagination aborts and accepts strictly advancing cursors", async () => {
    const classAbort = new AbortController();
    const classes = vi.fn().mockImplementationOnce(() => {
      classAbort.abort(new Error("stop"));
      return Promise.resolve({
        classes: [{ classId: skillClassId, displayName: "Physics" }],
        nextAfterClassId: OTHER_CLASS,
      });
    });
    await expect(
      readSkillAuthoringClasses({ classes } as never, classAbort.signal),
    ).rejects.toThrow("stop");
    expect(classes).toHaveBeenCalledOnce();

    const preAborted = new AbortController();
    preAborted.abort(new Error("already stopped"));
    const catalog = vi.fn();
    await expect(
      readSkillAuthoringCatalog({ catalog } as never, skillClassId, preAborted.signal),
    ).rejects.toThrow("already stopped");
    expect(catalog).not.toHaveBeenCalled();

    const advancing = vi
      .fn()
      .mockResolvedValueOnce({
        skills: [],
        nextAfterSkillId: "marea/a",
      })
      .mockResolvedValueOnce({
        skills: [],
        nextAfterSkillId: "marea/b",
      })
      .mockResolvedValueOnce({
        skills: [],
        nextAfterSkillId: null,
      });
    await expect(
      readSkillAuthoringCatalog(
        { catalog: advancing } as never,
        skillClassId,
        new AbortController().signal,
      ),
    ).resolves.toEqual([]);
    expect(advancing).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid navigation and local draft inputs without network work", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass("bad id");
    await controller.selectSkill("bad id");
    await controller.startPersonalDraft("Bad Slug");
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.readCatalog).not.toHaveBeenCalled();
    expect(mocks.readPersonal).not.toHaveBeenCalled();

    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft({ ...skillAuthoringDraftFixture, files: [] });
    await controller.validateDraft();
    expect(controller.state.problem).toBe("invalid");
    await controller.saveDraft(null);
    expect(mocks.save).not.toHaveBeenCalled();
    controller.editDraft(skillAuthoringDraftFixture);
    expect(controller.state.problem).toBe(null);
    expect(skillAuthoringStateFixture().pendingTarget).toBeNull();
  });

  it("distinguishes pending destinations, intermediate reads, and preserved problems", async () => {
    const { controller, mocks, changed } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);

    await controller.selectClass(OTHER_CLASS);
    expect(controller.state.pendingTarget).toEqual({ kind: "class", classId: OTHER_CLASS });
    await controller.selectClass(skillClassId);
    expect(controller.state.pendingTarget).toEqual({ kind: "class", classId: skillClassId });
    await controller.confirmNavigation(true);
    expect(controller.state).toMatchObject({
      classId: skillClassId,
      personalSlug: null,
      selectedSkillId: null,
      catalogLoaded: true,
    });

    await controller.startPersonalDraft("testing");
    mocks.readPersonal.mockRejectedValueOnce(failure("load"));
    await controller.reload();
    expect(controller.state.problem).toBe("load");
    await controller.startPersonalDraft("testing");
    expect(controller.state.problem).toBeNull();

    let finishPersonal: ((value: typeof skillReadFixture) => void) | undefined;
    mocks.readPersonal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPersonal = resolve;
        }),
    );
    const personalLoading = controller.startPersonalDraft("pending");
    await Promise.resolve();
    expect(controller.state).toMatchObject({
      classId: skillClassId,
      personalSlug: "pending",
      editable: true,
      draft: null,
      dirty: false,
      validation: null,
      recovery: null,
      pendingTarget: null,
      problem: null,
    });
    finishPersonal?.(skillReadFixture);
    await personalLoading;

    let finishCatalog: ((value: typeof skillCatalogFixture) => void) | undefined;
    mocks.catalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCatalog = resolve;
        }),
    );
    const classLoading = controller.loadCatalog(OTHER_CLASS);
    await Promise.resolve();
    expect(controller.state).toMatchObject({
      classId: OTHER_CLASS,
      catalog: [],
      catalogLoaded: false,
      selectedSkillId: null,
      personalSlug: null,
      loadedBundle: null,
      editable: false,
      draft: null,
      dirty: false,
    });
    finishCatalog?.(skillCatalogFixture);
    await classLoading;

    let finishRead: ((value: typeof skillReadFixture) => void) | undefined;
    mocks.readCatalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const readLoading = controller.selectSkill("marea/bundled");
    await Promise.resolve();
    expect(controller.state).toMatchObject({
      selectedSkillId: "marea/bundled",
      personalSlug: null,
      editable: false,
      draft: null,
      dirty: false,
    });
    finishRead?.(skillReadFixture);
    await readLoading;

    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ busy: true }));
    expect(controller.state.busy).toBe(false);
  });

  it("covers defensive navigation, edit, save, and recovery guards", async () => {
    const navigation = setup();
    await navigation.controller.selectClass(skillClassId);
    const catalogReads = navigation.mocks.readCatalog.mock.calls.length;
    await navigation.controller.selectSkill("bad id");
    expect(navigation.mocks.readCatalog).toHaveBeenCalledTimes(catalogReads);
    patchControllerFlag(navigation.controller, "operationBusy", true);
    await navigation.controller.selectSkill("marea/bundled");
    expect(navigation.mocks.readCatalog).toHaveBeenCalledTimes(catalogReads);
    patchControllerFlag(navigation.controller, "operationBusy", false);
    patchControllerFlag(navigation.controller, "disposed", true);
    await navigation.controller.selectSkill("marea/bundled");
    expect(navigation.mocks.readCatalog).toHaveBeenCalledTimes(catalogReads);
    patchControllerFlag(navigation.controller, "disposed", false);
    patchControllerState(navigation.controller, {
      selectedSkillId: "marea/bundled",
      dirty: true,
      pendingTarget: { kind: "personal", classId: skillClassId, slug: "testing" },
    });
    await navigation.controller.selectSkill("marea/bundled");
    expect(navigation.controller.state.pendingTarget).toEqual({
      kind: "skill",
      classId: skillClassId,
      skillId: "marea/bundled",
    });
    patchControllerState(navigation.controller, {
      pendingTarget: { kind: "class", classId: OTHER_CLASS },
    });
    patchControllerFlag(navigation.controller, "disposed", true);
    await navigation.controller.confirmNavigation(true);
    expect(navigation.controller.state.pendingTarget).toEqual({
      kind: "class",
      classId: OTHER_CLASS,
    });
    patchControllerFlag(navigation.controller, "disposed", false);
    patchControllerFlag(navigation.controller, "operationBusy", true);
    await navigation.controller.confirmNavigation(false);
    expect(navigation.controller.state.pendingTarget).toEqual({
      kind: "class",
      classId: OTHER_CLASS,
    });
    patchControllerFlag(navigation.controller, "operationBusy", false);

    const personal = setup();
    await personal.controller.selectClass(skillClassId);
    const personalReads = personal.mocks.readPersonal.mock.calls.length;
    await personal.controller.startPersonalDraft("bad slug");
    expect(personal.mocks.readPersonal).toHaveBeenCalledTimes(personalReads);
    patchControllerFlag(personal.controller, "operationBusy", true);
    await personal.controller.startPersonalDraft("next");
    expect(personal.mocks.readPersonal).toHaveBeenCalledTimes(personalReads);
    patchControllerFlag(personal.controller, "operationBusy", false);
    patchControllerFlag(personal.controller, "disposed", true);
    await personal.controller.startPersonalDraft("next");
    expect(personal.mocks.readPersonal).toHaveBeenCalledTimes(personalReads);
    patchControllerFlag(personal.controller, "disposed", false);
    patchControllerState(personal.controller, {
      personalSlug: "testing",
      editable: true,
      draft: skillAuthoringDraftFixture,
      dirty: true,
      pendingTarget: { kind: "class", classId: OTHER_CLASS },
      problem: null,
    });
    await personal.controller.startPersonalDraft("testing");
    expect(personal.controller.state.pendingTarget).toEqual({
      kind: "personal",
      classId: skillClassId,
      slug: "testing",
    });

    const editing = setup();
    await editing.controller.selectClass(skillClassId);
    patchControllerState(editing.controller, { editable: false, draft: null, problem: null });
    expect(() => {
      editing.controller.editDraft(EDITED_DIDACTIC);
    }).not.toThrow();
    expect(editing.controller.state.draft).toBeNull();
    patchControllerState(editing.controller, {
      editable: true,
      draft: skillAuthoringDraftFixture,
      problem: "load",
    });
    editing.controller.editDraft(EDITED_DIDACTIC);
    expect(editing.controller.state.problem).toBe("load");
    patchControllerState(editing.controller, {
      editable: true,
      draft: { ...skillAuthoringDraftFixture, files: [] },
      personalSlug: "testing",
      problem: null,
    });
    await editing.controller.saveDraft(null);
    expect(editing.controller.state.problem).toBe("invalid");
    expect(editing.mocks.save).not.toHaveBeenCalled();
    patchControllerState(editing.controller, {
      editable: true,
      draft: skillAuthoringDraftFixture,
      personalSlug: null,
      problem: null,
    });
    await editing.controller.saveDraft(null);
    expect(editing.mocks.save).not.toHaveBeenCalled();
    patchControllerState(editing.controller, {
      editable: false,
      draft: null,
      personalSlug: "testing",
      problem: null,
    });
    await editing.controller.saveDraft(null);
    expect(editing.mocks.save).not.toHaveBeenCalled();

    const reload = setup();
    await reload.controller.selectClass(skillClassId);
    await reload.controller.reload();
    expect(reload.mocks.readPersonal).not.toHaveBeenCalled();
    patchControllerState(reload.controller, {
      classId: null,
      personalSlug: "testing",
      pendingTarget: null,
    });
    await reload.controller.reload();
    expect(reload.mocks.readPersonal).not.toHaveBeenCalled();
    patchControllerState(reload.controller, { classId: skillClassId, personalSlug: null });
    await reload.controller.reload();
    expect(reload.mocks.readPersonal).not.toHaveBeenCalled();
    patchControllerState(reload.controller, {
      classId: skillClassId,
      personalSlug: "testing",
      pendingTarget: null,
    });
    patchControllerFlag(reload.controller, "operationBusy", true);
    await reload.controller.reload();
    expect(reload.mocks.readPersonal).not.toHaveBeenCalled();
    patchControllerFlag(reload.controller, "operationBusy", false);
    patchControllerState(reload.controller, { personalSlug: null });
    await reload.controller.startPersonalDraft("testing");
    patchControllerState(reload.controller, {
      pendingTarget: { kind: "class", classId: OTHER_CLASS },
    });
    await reload.controller.reload();
    expect(reload.mocks.readPersonal).toHaveBeenCalledOnce();
    patchControllerState(reload.controller, {
      pendingTarget: null,
      dirty: false,
      problem: "conflict",
      recovery: null,
    });
    await reload.controller.reload();
    expect(reload.controller.state.recovery).not.toBeNull();
    patchControllerState(reload.controller, {
      problem: "uncertain",
      recovery: null,
    });
    await reload.controller.reload();
    expect(reload.controller.state.recovery).not.toBeNull();
    Reflect.set(reload.controller, "recoverySlug", "copied");
    patchControllerState(reload.controller, { problem: null, recovery: null });
    await reload.controller.reload();
    expect(reload.mocks.readPersonal).toHaveBeenLastCalledWith(
      skillClassId,
      "copied",
      expect.any(AbortSignal),
    );
    expect(reload.controller.state.recovery).not.toBeNull();

    const accepting = setup();
    await accepting.controller.selectClass(skillClassId);
    expect(() => {
      accepting.controller.acceptReadback();
    }).not.toThrow();
    patchControllerState(accepting.controller, {
      recovery: skillReadFixture,
      pendingTarget: { kind: "class", classId: OTHER_CLASS },
      personalSlug: "testing",
    });
    accepting.controller.acceptReadback();
    expect(accepting.controller.state.recovery).toEqual(skillReadFixture);
    patchControllerState(accepting.controller, {
      classId: null,
      personalSlug: "testing",
      recovery: skillReadFixture,
      pendingTarget: null,
    });
    expect(() => {
      accepting.controller.acceptReadback();
    }).not.toThrow();
    expect(accepting.controller.state.recovery).toEqual(skillReadFixture);
    patchControllerState(accepting.controller, {
      classId: skillClassId,
      personalSlug: null,
      recovery: skillReadFixture,
      pendingTarget: null,
    });
    Reflect.set(accepting.controller, "recoverySlug", null);
    accepting.controller.acceptReadback();
    expect(accepting.controller.state.recovery).toEqual(skillReadFixture);
    patchControllerState(accepting.controller, {
      personalSlug: "testing",
      recovery: null,
    });
    accepting.controller.acceptReadback();
    expect(accepting.controller.state.recovery).toBeNull();
    patchControllerState(accepting.controller, { recovery: skillReadFixture });
    patchControllerFlag(accepting.controller, "operationBusy", true);
    accepting.controller.acceptReadback();
    expect(accepting.controller.state.recovery).toEqual(skillReadFixture);
    patchControllerFlag(accepting.controller, "operationBusy", false);
    patchControllerFlag(accepting.controller, "disposed", true);
    accepting.controller.acceptReadback();
    expect(accepting.controller.state.recovery).toEqual(skillReadFixture);
  });

  it("handles no-op guards, read-only personal results, and busy requests", async () => {
    const { controller, mocks } = setup();
    await controller.validateDraft();
    await controller.selectSkill("marea/bundled");
    await controller.startPersonalDraft("testing");
    await controller.loadCatalog("bad id");
    await controller.selectClass("bad id");
    await controller.selectSkill("bad id");
    await controller.startPersonalDraft("bad slug");
    await controller.startPersonalDraft("a".repeat(65));
    await controller.reload();
    await controller.confirmNavigation(false);
    controller.acceptReadback();
    expect(mocks.catalog).not.toHaveBeenCalled();

    await controller.selectClass(skillClassId);
    await controller.selectClass(skillClassId);
    await controller.selectSkill("marea/bundled");
    await controller.selectSkill("marea/bundled");
    await controller.startPersonalDraft("testing");
    await controller.startPersonalDraft("testing");
    expect(mocks.readCatalog).toHaveBeenCalledOnce();
    expect(mocks.readPersonal).toHaveBeenCalledOnce();
    await controller.validateDraft();
    controller.editDraft(skillAuthoringDraftFixture);

    let finishCatalog: ((value: typeof skillCatalogFixture) => void) | undefined;
    mocks.catalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCatalog = resolve;
        }),
    );
    const busy = controller.loadCatalog(skillClassId);
    await controller.loadCatalog(skillClassId);
    await controller.selectClass(OTHER_CLASS);
    await controller.confirmNavigation(true);
    await controller.reload();
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
    finishCatalog?.(skillCatalogFixture);
    await busy;
    await controller.loadCatalog(OTHER_CLASS);
    controller.dispose();
    controller.dispose();
  });

  it("preserves readonly personal reads and failed recovery locks", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    mocks.readPersonal.mockResolvedValueOnce(
      SkillAuthoringReadResponseSchema.parse({ ...skillReadFixture, editable: false }),
    );
    await controller.startPersonalDraft("readonly");
    expect(controller.state).toMatchObject({ editable: false, draft: null });

    await controller.startPersonalDraft("new");
    controller.editDraft(EDITED_DIDACTIC);
    mocks.save.mockRejectedValueOnce(failure("conflict"));
    await controller.saveDraft(null);
    mocks.readPersonal.mockRejectedValueOnce(failure("load"));
    await controller.reload();
    expect(controller.state).toMatchObject({ problem: "conflict", recovery: null, dirty: true });
    await controller.loadCatalog(skillClassId);
    expect(controller.state.problem).toBe("conflict");
    mocks.catalog.mockRejectedValueOnce(new Error("catalog unavailable"));
    await controller.loadCatalog(skillClassId);
    expect(controller.state.problem).toBe("load");
  });

  it("stages a successful copy behind a dirty navigation confirmation", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);
    mocks.copy.mockResolvedValueOnce(SkillAuthoringCopyResponseSchema.parse(skillCopiedFixture));
    await controller.copySkill("marea/bundled", skillSavedFixture.skill.digest, "copied");
    expect(controller.state).toMatchObject({
      dirty: true,
      pendingTarget: { kind: "personal", classId: skillClassId, slug: "copied" },
      draft: EDITED_DIDACTIC,
    });
    await controller.confirmNavigation(true);
    expect(controller.state.personalSlug).toBe("copied");
  });

  it("confirms a dirty class target and classifies unknown operation errors", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);
    await controller.selectClass(OTHER_CLASS);
    await controller.confirmNavigation(true);
    expect(controller.state.classId).toBe(OTHER_CLASS);

    await controller.startPersonalDraft("other");
    mocks.validate.mockRejectedValueOnce(new Error("validation unavailable"));
    await controller.validateDraft();
    expect(controller.state.problem).toBe("invalid");
    await controller.startPersonalDraft("other");
    mocks.save.mockRejectedValueOnce(new Error("save unavailable"));
    await controller.saveDraft(null);
    expect(controller.state.problem).toBe("uncertain");
    mocks.catalog.mockRejectedValueOnce(new Error("catalog unavailable"));
    await controller.loadCatalog(OTHER_CLASS);
    expect(controller.state.problem).toBe("load");
  });

  it("keeps write recovery explicit across reload and confirmation guards", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");

    mocks.save.mockRejectedValueOnce(new Error("save unavailable"));
    controller.editDraft(EDITED_DIDACTIC);
    await controller.saveDraft(null);
    expect(controller.state.problem).toBe("uncertain");
    mocks.readPersonal.mockResolvedValueOnce(skillReadFixture);
    await controller.reload();
    expect(controller.state).toMatchObject({ problem: "uncertain", recovery: skillReadFixture });

    controller.acceptReadback();
    controller.editDraft(EDITED_DIDACTIC);
    await controller.selectClass(OTHER_CLASS);
    expect(controller.state.pendingTarget).toEqual({ kind: "class", classId: OTHER_CLASS });
    controller.acceptReadback();
    expect(controller.state.pendingTarget).toEqual({ kind: "class", classId: OTHER_CLASS });
    await controller.confirmNavigation(false);
    expect(controller.state.pendingTarget).toBeNull();

    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    mocks.copy.mockRejectedValueOnce(new Error("copy uncertain"));
    await controller.copySkill("marea/bundled", skillSavedFixture.skill.digest, "copied");
    expect(controller.state.problem).toBe("uncertain");
    mocks.readPersonal.mockResolvedValueOnce(skillReadFixture);
    await controller.reload();
    expect(mocks.readPersonal).toHaveBeenLastCalledWith(
      skillClassId,
      "copied",
      expect.any(AbortSignal),
    );
    expect(controller.state.recovery).toEqual(skillReadFixture);

    const beforeNoTarget = controller.state;
    await controller.confirmNavigation(true);
    expect(controller.state).toBe(beforeNoTarget);
  });

  it("blocks operations while busy or aborted and aborts on disposal", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    await controller.startPersonalDraft("testing");
    controller.editDraft(EDITED_DIDACTIC);
    await controller.selectClass(OTHER_CLASS);

    const pendingClasses = deferredClasses();
    mocks.classes.mockImplementationOnce(pendingClasses.implementation);
    const loading = controller.loadClasses();
    await Promise.resolve();
    const target = controller.state.pendingTarget;
    await controller.confirmNavigation(true);
    expect(controller.state.pendingTarget).toBe(target);
    pendingClasses.finish();
    await loading;
    expect(controller.state.busy).toBe(false);

    const second = setup();
    const secondAbort = Reflect.get(second.controller, "abort") as AbortController;
    secondAbort.abort();
    await second.controller.loadClasses();
    expect(second.mocks.classes).not.toHaveBeenCalled();

    const third = setup();
    let pendingSignal: AbortSignal | undefined;
    let finishPending: (() => void) | undefined;
    third.mocks.readPersonal.mockImplementationOnce((_classId, _slug, signal) => {
      pendingSignal = signal;
      return new Promise((resolve) => {
        finishPending = () => {
          resolve(skillReadFixture);
        };
      });
    });
    await third.controller.selectClass(skillClassId);
    const pending = third.controller.startPersonalDraft("testing");
    await Promise.resolve();
    third.controller.dispose();
    expect(pendingSignal?.aborted).toBe(true);
    finishPending?.();
    await pending;
  });

  it("publishes class reset state before the catalog read and preserves perform guards", async () => {
    const opening = setup();
    await opening.controller.selectClass(skillClassId);
    let finishCatalog: (() => void) | undefined;
    opening.mocks.catalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCatalog = () => {
            resolve(skillCatalogFixture);
          };
        }),
    );
    const classOpening = opening.controller.selectClass(OTHER_CLASS);
    await Promise.resolve();
    expect(opening.controller.state).toMatchObject({
      classId: OTHER_CLASS,
      catalog: [],
      catalogLoaded: false,
      selectedSkillId: null,
      personalSlug: null,
      editable: false,
    });
    finishCatalog?.();
    await classOpening;

    const busy = setup();
    patchControllerState(busy.controller, {
      classes: [{ classId: skillClassId, displayName: "Physics" }],
      classesLoaded: true,
      problem: "conflict",
    });
    const pendingClasses = deferredClasses();
    busy.mocks.classes.mockImplementationOnce(pendingClasses.implementation);
    const loading = busy.controller.loadClasses();
    await Promise.resolve();
    expect(busy.controller.state).toMatchObject({ classes: [], classesLoaded: false });
    const callCount = busy.mocks.classes.mock.calls.length;
    await busy.controller.loadClasses();
    expect(busy.mocks.classes).toHaveBeenCalledTimes(callCount);
    pendingClasses.finish();
    await loading;
    expect(busy.controller.state.problem).toBe("conflict");

    const aborted = setup();
    const abort = Reflect.get(aborted.controller, "abort") as AbortController;
    abort.abort();
    await aborted.controller.loadClasses();
    expect(aborted.controller.state.problem).toBeNull();
    aborted.controller.dispose();
    await aborted.controller.loadClasses();
    expect(aborted.controller.state.problem).toBeNull();
  });

  it("does not publish a late error after disposal", async () => {
    const { controller, mocks } = setup();
    await controller.selectClass(skillClassId);
    let rejectRead: ((error: Error) => void) | undefined;
    mocks.readPersonal.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRead = reject;
        }),
    );
    const loading = controller.startPersonalDraft("testing");
    controller.dispose();
    rejectRead?.(new Error("late failure"));
    await loading;

    const second = setup();
    await second.controller.selectClass(skillClassId);
    let rejectCatalog: ((error: Error) => void) | undefined;
    second.mocks.catalog.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectCatalog = reject;
        }),
    );
    const catalogLoading = second.controller.loadCatalog(skillClassId);
    second.controller.dispose();
    rejectCatalog?.(new Error("late catalog failure"));
    await catalogLoading;
  });
});
