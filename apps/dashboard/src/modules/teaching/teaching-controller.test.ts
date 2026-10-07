import { describe, expect, it, vi } from "vitest";

import type { TeachingClientFailure, TeachingProblem } from "./teaching-contracts.js";
import { TeachingController } from "./teaching-controller.js";
import {
  CLASS_A,
  CLASS_B,
  DIGEST,
  VERSION_A,
  VERSION_B,
  VERSION_C,
  catalogPage,
  classesPage,
  classSummary,
  configuration,
  mockClient,
  readResponse,
  savedResponse,
  settings,
  skillEntry,
} from "./teaching-controller.fixture.js";

function failure(code: TeachingProblem): TeachingClientFailure {
  return Object.assign(new Error(code), { code });
}

const DEFAULT_SETTINGS = settings({
  classInstructions: { tutoring: "", free: "" },
  socraticMode: "normal",
});
const EDITED = settings({ classInstructions: { tutoring: "Edited draft.", free: "" } });

function setup() {
  const client = mockClient();
  const changed = vi.fn();
  const controller = new TeachingController(client, changed);
  return { client, changed, controller };
}

describe("teaching state controller", () => {
  it("starts empty, loads deduplicated class pages, and never auto-selects", async () => {
    const { client, changed, controller } = setup();
    expect(controller.state.busy).toBe(false);
    expect(controller.state.classes).toEqual([]);
    expect(controller.state.classesLoaded).toBe(false);
    expect(controller.state.classId).toBeNull();
    expect(controller.state.catalog).toEqual([]);
    expect(controller.state.configuration).toBeNull();
    expect(controller.state.operatorReady).toBe(false);
    expect(controller.state.draft).toBeNull();
    expect(controller.state.dirty).toBe(false);
    expect(controller.state.problem).toBeNull();
    expect(controller.state.recovery).toBeNull();
    expect(controller.state.pendingClassId).toBeNull();
    client.classes
      .mockResolvedValueOnce(
        classesPage([classSummary(CLASS_A), classSummary(CLASS_A, "Physics")], CLASS_A),
      )
      .mockResolvedValueOnce(classesPage([classSummary(CLASS_B), classSummary(CLASS_B)], null));
    await controller.loadClasses();
    expect(client.classes).toHaveBeenNthCalledWith(1, null, expect.any(AbortSignal));
    expect(client.classes).toHaveBeenNthCalledWith(2, CLASS_A, expect.any(AbortSignal));
    expect(controller.state).toMatchObject({
      classes: [classSummary(CLASS_A), classSummary(CLASS_B)],
      classesLoaded: true,
      classId: null,
      problem: null,
    });
    expect(changed).toHaveBeenLastCalledWith(controller.state);
  });

  it("blocks saves without a selection or without a draft", async () => {
    const { client, controller } = setup();
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();
    await controller.loadClasses();
    controller.state = { ...controller.state, operatorReady: true, draft: settings() };
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();
  });

  it("handles empty class lists and non-advancing cursors", async () => {
    const { client, controller } = setup();
    await controller.loadClasses();
    expect(controller.state).toMatchObject({ classes: [], classesLoaded: true, problem: null });

    client.classes.mockResolvedValue(classesPage([], CLASS_A));
    await controller.loadClasses();
    expect(controller.state.problem).toBe("load");
  });

  it("selects a class, paginates a deduplicated catalog, and stages null configurations", async () => {
    const { client, controller } = setup();
    client.read.mockResolvedValueOnce(readResponse(CLASS_A, null, false));
    client.catalog
      .mockResolvedValueOnce(catalogPage(CLASS_A, [skillEntry()], "marea/testing"))
      .mockResolvedValueOnce(
        catalogPage(CLASS_A, [skillEntry(), skillEntry("marea/writing")], null),
      );
    await controller.selectClass(CLASS_A);
    expect(client.read).toHaveBeenLastCalledWith(CLASS_A, expect.any(AbortSignal));
    expect(client.catalog).toHaveBeenNthCalledWith(1, CLASS_A, null, expect.any(AbortSignal));
    expect(client.catalog).toHaveBeenNthCalledWith(
      2,
      CLASS_A,
      "marea/testing",
      expect.any(AbortSignal),
    );
    expect(controller.state).toMatchObject({
      classId: CLASS_A,
      configuration: null,
      draft: DEFAULT_SETTINGS,
      dirty: false,
      operatorReady: false,
      catalog: [skillEntry(), skillEntry("marea/writing")],
    });
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();
  });

  it("rejects non-advancing catalog cursors and keeps read failures visible", async () => {
    const { client, controller } = setup();
    client.catalog.mockResolvedValue(catalogPage(CLASS_A, [], "marea/testing"));
    await controller.selectClass(CLASS_A);
    expect(controller.state).toMatchObject({ classId: CLASS_A, problem: "load" });

    client.read.mockRejectedValueOnce(failure("forbidden"));
    await controller.selectClass(CLASS_B);
    expect(controller.state).toMatchObject({ classId: CLASS_B, problem: "forbidden" });
    controller.edit(EDITED);
    expect(controller.state).toMatchObject({ problem: "forbidden", draft: null });
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();
    controller.edit(DEFAULT_SETTINGS);
    expect(controller.state.dirty).toBe(false);

    client.read.mockRejectedValueOnce(failure("unconfigured"));
    await controller.selectClass(CLASS_A);
    expect(controller.state.problem).toBe("unconfigured");

    client.catalog.mockRejectedValueOnce(failure("skill-unavailable"));
    await controller.selectClass(CLASS_B);
    expect(controller.state.problem).toBe("skill-unavailable");

    client.read.mockRejectedValueOnce(new Error("connection lost"));
    await controller.selectClass(CLASS_A);
    expect(controller.state).toMatchObject({ classId: CLASS_A, problem: "load", draft: null });
    controller.state = { ...controller.state, operatorReady: true };
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();
    expect(controller.state.problem).toBe("load");
  });

  it("serializes overlapping operations and suppresses stale edits after disposal", async () => {
    const { client, changed, controller } = setup();
    let resolveRead: ((response: ReturnType<typeof readResponse>) => void) | undefined;
    client.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const loading = controller.selectClass(CLASS_A);
    expect(controller.state.busy).toBe(true);
    expect(controller.state.operatorReady).toBe(false);
    expect(controller.state.catalog).toEqual([]);
    const concurrent = controller.selectClass(CLASS_B);
    controller.edit(EDITED);
    await controller.loadClasses();
    await controller.save();
    expect(client.read).toHaveBeenCalledOnce();
    expect(client.classes).not.toHaveBeenCalled();
    expect(client.save).not.toHaveBeenCalled();
    expect(controller.state.draft).toBeNull();

    controller.dispose();
    expect(client.read.mock.calls[0]?.[1]?.aborted).toBe(true);
    const updates = changed.mock.calls.length;
    resolveRead?.(readResponse(CLASS_A, null, true));
    await Promise.all([loading, concurrent]);
    expect(changed).toHaveBeenCalledTimes(updates);
    await controller.loadClasses();
    await controller.selectClass(CLASS_B);
    controller.edit(EDITED);
    await controller.save();
    expect(changed).toHaveBeenCalledTimes(updates);
    expect(client.read).toHaveBeenCalledOnce();
    expect(client.catalog).not.toHaveBeenCalled();
  });

  it("keeps same-class selections and stages dirty class switches until confirmed", async () => {
    const { client, changed, controller } = setup();
    await controller.confirmClassSwitch(false);
    await controller.confirmClassSwitch(true);
    controller.acceptReload();
    expect(changed).not.toHaveBeenCalled();
    await controller.selectClass(CLASS_A);
    controller.edit(EDITED);
    await controller.selectClass(CLASS_A);
    expect(controller.state).toMatchObject({
      classId: CLASS_A,
      pendingClassId: null,
      dirty: true,
      draft: EDITED,
    });
    expect(client.read).toHaveBeenCalledOnce();

    await controller.selectClass(CLASS_B);
    expect(controller.state).toMatchObject({ pendingClassId: CLASS_B, classId: CLASS_A });
    expect(client.read).toHaveBeenCalledOnce();
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();
    await controller.confirmClassSwitch(false);
    expect(controller.state).toMatchObject({ pendingClassId: null, draft: EDITED });

    await controller.selectClass(CLASS_B);
    await controller.confirmClassSwitch(true);
    expect(client.read).toHaveBeenCalledTimes(2);
    expect(controller.state).toMatchObject({
      classId: CLASS_B,
      pendingClassId: null,
      dirty: false,
      draft: DEFAULT_SETTINGS,
    });
  });

  it("edits both modes, keeps inactive values, and recomputes dirty state", async () => {
    const { client, controller } = setup();
    client.read.mockResolvedValueOnce(readResponse(CLASS_A, configuration(VERSION_A, settings())));
    await controller.selectClass(CLASS_A);
    controller.edit(settings());
    expect(controller.state).toMatchObject({ dirty: false, draft: settings() });
    controller.edit({
      ...settings(),
      agentMode: "free",
      classInstructions: { tutoring: "Ask one question.", free: "Support the project." },
    });
    expect(controller.state).toMatchObject({
      dirty: true,
      draft: {
        agentMode: "free",
        classInstructions: { tutoring: "Ask one question.", free: "Support the project." },
        selection: { didactic: [], evaluation: [] },
        automaticEvaluation: false,
      },
    });
  });

  it("validates drafts before saving and adopts confirmed save responses", async () => {
    const { client, controller } = setup();
    client.read.mockResolvedValueOnce(readResponse(CLASS_A, configuration(VERSION_A, settings())));
    await controller.selectClass(CLASS_A);
    const invalidDraft = { ...settings(), automaticEvaluation: true };
    controller.edit(invalidDraft);
    await controller.save();
    expect(controller.state).toMatchObject({ problem: "invalid", dirty: true });
    expect(client.save).not.toHaveBeenCalled();
    expect(controller.state.draft).toEqual(invalidDraft);

    const evaluationChoice = settings({
      automaticEvaluation: true,
      selection: { didactic: [], evaluation: [{ id: "marea/evaluation", digest: DIGEST }] },
    });
    controller.edit(evaluationChoice);
    expect(controller.state).toMatchObject({ problem: null });
    const saved = savedResponse(CLASS_A, configuration(VERSION_B, evaluationChoice));
    client.save.mockResolvedValueOnce(saved);
    await controller.save();
    const saveCall = client.save.mock.calls[0];
    expect(saveCall?.slice(0, 3)).toEqual([CLASS_A, VERSION_A, evaluationChoice]);
    expect(saveCall?.[3]).toBeInstanceOf(AbortSignal);
    expect(controller.state).toMatchObject({
      configuration: { version: VERSION_B, settings: evaluationChoice },
      draft: evaluationChoice,
      dirty: false,
      problem: null,
      operatorReady: true,
    });
  });

  it("saves a first configuration with a null expected version", async () => {
    const { client, controller } = setup();
    await controller.selectClass(CLASS_A);
    const first = settings({
      agentMode: "free",
      classInstructions: { tutoring: "", free: "Work." },
    });
    controller.edit(first);
    client.save.mockResolvedValueOnce(savedResponse(CLASS_A, configuration(VERSION_A, first)));
    await controller.save();
    expect(client.save).toHaveBeenLastCalledWith(CLASS_A, null, first, expect.any(AbortSignal));
    expect(controller.state).toMatchObject({
      configuration: { version: VERSION_A, settings: first },
      draft: first,
      dirty: false,
    });
  });

  it("preserves conflicting and uncertain drafts and requires explicit recovery", async () => {
    const { client, controller } = setup();
    client.read.mockResolvedValue(readResponse(CLASS_A, configuration(VERSION_A, settings())));
    await controller.selectClass(CLASS_A);
    controller.edit(EDITED);

    client.save.mockRejectedValueOnce(failure("conflict"));
    await controller.save();
    expect(controller.state).toMatchObject({ problem: "conflict", draft: EDITED, dirty: true });
    controller.edit(settings({ classInstructions: { tutoring: "Rejected edit.", free: "" } }));
    expect(controller.state.draft).toEqual(EDITED);
    await controller.save();
    expect(client.save).toHaveBeenCalledOnce();

    await controller.reload();
    expect(controller.state).toMatchObject({
      recovery: readResponse(CLASS_A, configuration(VERSION_A, settings())),
      draft: EDITED,
      problem: "conflict",
    });
    controller.edit(settings({ classInstructions: { tutoring: "Recovery edit.", free: "" } }));
    expect(controller.state.draft).toEqual(EDITED);
    client.save.mockClear();
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();

    controller.acceptReload();
    expect(controller.state).toMatchObject({
      recovery: null,
      problem: null,
      configuration: { version: VERSION_A, settings: settings() },
      draft: settings(),
      dirty: false,
    });
    expect(client.save).not.toHaveBeenCalled();

    client.save.mockRejectedValueOnce(failure("uncertain"));
    controller.edit(EDITED);
    await controller.save();
    expect(controller.state).toMatchObject({ problem: "uncertain", draft: EDITED });
    controller.edit(settings({ classInstructions: { tutoring: "Lost edit.", free: "" } }));
    expect(controller.state.draft).toEqual(EDITED);
    await controller.save();
    expect(client.save).toHaveBeenCalledOnce();

    const newer = readResponse(CLASS_A, configuration(VERSION_B, settings()));
    client.read.mockResolvedValueOnce(newer);
    client.catalog.mockResolvedValueOnce(catalogPage(CLASS_A, [skillEntry()], null));
    await controller.reload();
    expect(controller.state).toMatchObject({
      recovery: newer,
      configuration: { version: VERSION_A, settings: settings() },
      draft: EDITED,
      dirty: true,
      problem: "uncertain",
      catalog: [skillEntry()],
      operatorReady: true,
    });
    await controller.save();
    expect(client.save).toHaveBeenCalledOnce();
    controller.acceptReload();
    expect(controller.state).toMatchObject({
      recovery: null,
      configuration: { version: VERSION_B, settings: settings() },
      draft: settings(),
      dirty: false,
      problem: null,
    });
    expect(client.save).toHaveBeenCalledOnce();

    const adopted = savedResponse(CLASS_A, configuration(VERSION_C, EDITED));
    client.save.mockResolvedValueOnce(adopted);
    controller.edit(EDITED);
    await controller.save();
    expect(client.save).toHaveBeenLastCalledWith(
      CLASS_A,
      VERSION_B,
      EDITED,
      expect.any(AbortSignal),
    );
    expect(controller.state).toMatchObject({
      configuration: { version: VERSION_C, settings: EDITED },
      dirty: false,
      problem: null,
    });
  });

  it("adopts clean reloads directly and keeps failed recovery reads non-destructive", async () => {
    const { client, controller } = setup();
    await controller.reload();
    expect(client.read).not.toHaveBeenCalled();
    await controller.selectClass(CLASS_A);
    client.read.mockResolvedValueOnce(readResponse(CLASS_A, configuration(VERSION_B, EDITED)));
    client.catalog.mockResolvedValueOnce(catalogPage(CLASS_A, [skillEntry()], null));
    await controller.reload();
    expect(controller.state).toMatchObject({
      configuration: { version: VERSION_B, settings: EDITED },
      draft: EDITED,
      dirty: false,
      recovery: null,
      catalog: [skillEntry()],
    });

    client.read.mockResolvedValueOnce(readResponse(CLASS_A, null, false));
    await controller.reload();
    expect(controller.state).toMatchObject({
      configuration: null,
      operatorReady: false,
      draft: DEFAULT_SETTINGS,
      dirty: false,
      recovery: null,
    });

    client.read.mockResolvedValueOnce(readResponse(CLASS_A, null, false));
    await controller.reload();
    expect(controller.state.operatorReady).toBe(false);
    expect(controller.state.draft).toEqual(DEFAULT_SETTINGS);

    controller.edit(EDITED);
    const dirtyRead = readResponse(CLASS_A, configuration(VERSION_A, settings()));
    client.read.mockResolvedValueOnce(dirtyRead);
    client.catalog.mockResolvedValueOnce(catalogPage(CLASS_A, [], null));
    await controller.reload();
    expect(controller.state).toMatchObject({
      recovery: dirtyRead,
      draft: EDITED,
      dirty: true,
      problem: null,
      operatorReady: true,
    });
    client.save.mockClear();
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();

    client.read.mockRejectedValueOnce(failure("load"));
    await controller.reload();
    expect(controller.state).toMatchObject({
      problem: "load",
      recovery: dirtyRead,
      draft: EDITED,
    });
    controller.edit(DEFAULT_SETTINGS);
    expect(controller.state).toMatchObject({ problem: "load", draft: EDITED });
    controller.acceptReload();
    expect(controller.state).toMatchObject({
      recovery: null,
      configuration: { version: VERSION_A, settings: settings() },
      draft: settings(),
      problem: null,
      dirty: false,
      operatorReady: true,
    });
  });

  it("fills recovery for conflict and uncertain problems without a dirty draft", async () => {
    const { client, controller } = setup();
    client.read.mockResolvedValue(readResponse(CLASS_A, configuration(VERSION_A, settings())));
    await controller.selectClass(CLASS_A);
    controller.state = { ...controller.state, problem: "conflict" };
    const conflictRead = readResponse(CLASS_A, configuration(VERSION_B, settings()));
    client.read.mockResolvedValueOnce(conflictRead);
    client.catalog.mockResolvedValueOnce(catalogPage(CLASS_A, [], null));
    await controller.reload();
    expect(controller.state).toMatchObject({
      recovery: conflictRead,
      draft: settings(),
      dirty: false,
      problem: "conflict",
    });
    controller.acceptReload();
    controller.state = { ...controller.state, problem: "uncertain" };
    client.read.mockResolvedValueOnce(readResponse(CLASS_A, null, true));
    await controller.reload();
    expect(controller.state).toMatchObject({
      recovery: readResponse(CLASS_A, null, true),
      draft: settings(),
      problem: "uncertain",
    });
  });
});
