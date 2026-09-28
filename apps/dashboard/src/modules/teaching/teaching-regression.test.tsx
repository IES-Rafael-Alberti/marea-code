import { describe, expect, it, vi } from "vitest";

import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";
import { TeachingController } from "./teaching-controller.js";
import {
  CLASS_A,
  CLASS_B,
  classSummary,
  classesPage,
  catalogPage,
  mockClient,
  readResponse,
  settings,
} from "./teaching-controller.fixture.js";
import { teachingMessages } from "./teaching-messages.js";
import { TeachingModule } from "./teaching-module.js";

function saveButton(controller: TeachingController) {
  const m = teachingMessages("en");
  const blocked =
    controller.state.problem === "uncertain" || controller.state.problem === "conflict";
  return reviewButton(
    reviewElements(<TeachingModule locale="en" state={controller.state} controller={controller} />),
    blocked ? m.saveBlocked : m.save,
  );
}

describe("teaching controller and view regressions", () => {
  it("clears a transient class-list error on successful retry", async () => {
    const client = mockClient();
    client.classes.mockRejectedValueOnce(new Error("offline"));
    const controller = new TeachingController(client, vi.fn());
    await controller.loadClasses();
    expect(controller.state.problem).toBe("load");
    await controller.loadClasses();
    expect(controller.state.problem).toBeNull();
    expect(controller.state.classesLoaded).toBe(true);
  });

  it("ignores invalid selections without discarding the active draft", async () => {
    const client = mockClient();
    const controller = new TeachingController(client, vi.fn());
    await controller.selectClass(CLASS_A);
    const before = controller.state;
    await controller.selectClass("");
    expect(controller.state).toBe(before);
    controller.edit(settings());
    const edited = controller.state;
    await controller.selectClass("bad id");
    expect(controller.state).toBe(edited);
    expect(client.read).toHaveBeenCalledTimes(1);
  });
  it("permits the first configuration with untouched defaults", async () => {
    const client = mockClient();
    const controller = new TeachingController(client, vi.fn());
    await controller.selectClass(CLASS_A);
    expect(controller.state.dirty).toBe(false);
    expect(saveButton(controller).props.disabled).toBe(false);
    saveButton(controller).props.onClick?.();
    expect(client.save).toHaveBeenCalledWith(
      CLASS_A,
      null,
      controller.state.draft,
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => {
      expect(controller.state.busy).toBe(false);
    });
  });

  it.each(["uncertain", "conflict"] as const)(
    "retains the %s write lock after either failed read",
    async (code) => {
      const client = mockClient();
      const controller = new TeachingController(client, vi.fn());
      await controller.selectClass(CLASS_A);
      controller.edit(settings());
      const draft = controller.state.draft;
      client.save.mockRejectedValue(Object.assign(new Error("save failed"), { code }));
      await controller.save();
      client.read.mockRejectedValue(new Error("offline"));
      await controller.reload();
      client.classes.mockRejectedValue(new Error("offline"));
      await controller.loadClasses();
      expect(controller.state.problem).toBe(code);
      expect(controller.state.draft).toBe(draft);
      expect(controller.state.recovery).toBeNull();
      expect(saveButton(controller).props.disabled).toBe(true);
      controller.edit(settings({ agentMode: "free" }));
      await controller.save();
      expect(controller.state.draft).toBe(draft);
      expect(client.save).toHaveBeenCalledTimes(1);
      client.classes.mockResolvedValue(classesPage([]));
      await controller.loadClasses();
      expect(controller.state.problem).toBe(code);
    },
  );

  it("rejects backwards class cursors before requesting a third page", async () => {
    const client = mockClient();
    client.classes
      .mockResolvedValueOnce(classesPage([], "class:z"))
      .mockResolvedValueOnce(classesPage([], "class:a"));
    const controller = new TeachingController(client, vi.fn());
    await controller.loadClasses();
    expect(client.classes).toHaveBeenCalledTimes(2);
    expect(controller.state.problem).toBe("load");
    expect(controller.state.classesLoaded).toBe(false);
  });

  it("loads three strictly advancing pages of classes and catalog", async () => {
    const client = mockClient();
    client.classes
      .mockResolvedValueOnce(classesPage([classSummary("class:a")], "class:a"))
      .mockResolvedValueOnce(classesPage([classSummary("class:b")], "class:b"))
      .mockResolvedValueOnce(classesPage([classSummary("class:c")]));
    client.catalog
      .mockResolvedValueOnce(catalogPage(CLASS_A, [], "marea/a"))
      .mockResolvedValueOnce(catalogPage(CLASS_A, [], "marea/b"));
    const controller = new TeachingController(client, vi.fn());
    await controller.loadClasses();
    expect(controller.state.classes.map((entry) => entry.classId)).toEqual([
      "class:a",
      "class:b",
      "class:c",
    ]);
    await controller.selectClass(CLASS_A);
    expect(client.catalog).toHaveBeenCalledTimes(3);
    expect(controller.state.problem).toBeNull();
    expect(controller.state.draft).not.toBeNull();
  });

  it("freezes editor, selector, save and recovery acceptance during switches and loading", async () => {
    const client = mockClient();
    client.classes.mockResolvedValue(classesPage([classSummary()]));
    const controller = new TeachingController(client, vi.fn());
    await controller.loadClasses();
    await controller.selectClass(CLASS_A);
    controller.edit(settings());
    await controller.reload();
    const recovered = reviewElements(
      <TeachingModule locale="en" state={controller.state} controller={controller} />,
    );
    expect(reviewButton(recovered, teachingMessages("en").acceptCurrent).props.disabled).toBe(
      false,
    );
    expect(reviewButton(recovered, teachingMessages("en").discardDraft).props.disabled).toBe(false);
    await controller.selectClass(CLASS_B);
    const pending = controller.state;
    controller.edit(settings({ agentMode: "free" }));
    controller.acceptReload();
    expect(controller.state).toBe(pending);
    const assertDisabled = () => {
      const elements = reviewElements(
        <TeachingModule locale="en" state={controller.state} controller={controller} />,
      );
      expect(elements.find((entry) => entry.type === "select")?.props.disabled).toBe(true);
      expect(elements.find((entry) => entry.type === "fieldset")?.props.disabled).toBe(true);
      expect(saveButton(controller).props.disabled).toBe(true);
      expect(reviewButton(elements, teachingMessages("en").acceptCurrent).props.disabled).toBe(
        true,
      );
      expect(reviewButton(elements, teachingMessages("en").discardDraft).props.disabled).toBe(true);
    };
    assertDisabled();
    let finish: ((value: ReturnType<typeof readResponse>) => void) | undefined;
    client.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = controller.reload();
    const busy = controller.state;
    await controller.confirmClassSwitch(false);
    expect(controller.state).toBe(busy);
    finish?.(readResponse(CLASS_A, null));
    await loading;
    await controller.confirmClassSwitch(false);
    client.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reloading = controller.reload();
    const frozen = controller.state;
    controller.edit(settings({ agentMode: "free" }));
    controller.acceptReload();
    await controller.selectClass(CLASS_B);
    expect(controller.state).toBe(frozen);
    assertDisabled();
    finish?.(readResponse(CLASS_A, null));
    await reloading;
  });

  it("preserves non-validation save errors when editing a loaded draft", async () => {
    const client = mockClient();
    const controller = new TeachingController(client, vi.fn());
    await controller.selectClass(CLASS_A);
    client.save.mockRejectedValue(
      Object.assign(new Error("unconfigured"), { code: "unconfigured" }),
    );
    await controller.save();
    controller.edit(settings());
    expect(controller.state.problem).toBe("unconfigured");
  });

  it("blocks draft edits and saving for a pending switch without recovery", async () => {
    const client = mockClient();
    const controller = new TeachingController(client, vi.fn());
    await controller.selectClass(CLASS_A);
    controller.edit(settings());
    await controller.selectClass(CLASS_B);
    const before = controller.state;
    controller.edit(settings({ agentMode: "free" }));
    expect(controller.state).toBe(before);
    expect(saveButton(controller).props.disabled).toBe(true);
    const elements = reviewElements(
      <TeachingModule locale="en" state={controller.state} controller={controller} />,
    );
    expect(elements.find((entry) => entry.type === "fieldset")?.props.disabled).toBe(true);
  });

  it("blocks busy edits and class switches without any recovery or pending switch", async () => {
    const client = mockClient();
    const controller = new TeachingController(client, vi.fn());
    await controller.selectClass(CLASS_A);
    controller.edit(settings());
    let finish: ((value: ReturnType<typeof classesPage>) => void) | undefined;
    client.classes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = controller.loadClasses();
    const before = controller.state;
    controller.edit(settings({ agentMode: "free" }));
    await controller.selectClass(CLASS_B);
    expect(controller.state).toBe(before);
    finish?.(classesPage([]));
    await loading;
  });

  it("stops pagination after disposal even when the transport ignores abort", async () => {
    const client = mockClient();
    const controller = new TeachingController(client, vi.fn());
    client.classes.mockImplementationOnce(() => {
      controller.dispose();
      return Promise.resolve(classesPage([], CLASS_A));
    });
    await controller.loadClasses();
    expect(client.classes).toHaveBeenCalledTimes(1);
    const catalogClient = mockClient();
    const catalogController = new TeachingController(catalogClient, vi.fn());
    catalogClient.catalog.mockImplementationOnce(() => {
      catalogController.dispose();
      return Promise.resolve(catalogPage(CLASS_A, [], "marea/a"));
    });
    await catalogController.selectClass(CLASS_A);
    expect(catalogClient.catalog).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a partial catalog or enable saving after backwards pagination", async () => {
    const client = mockClient();
    client.catalog
      .mockResolvedValueOnce(catalogPage(CLASS_A, [], "marea/z"))
      .mockResolvedValueOnce(catalogPage(CLASS_A, [], "marea/a"));
    const controller = new TeachingController(client, vi.fn());
    await controller.selectClass(CLASS_A);
    expect(client.catalog).toHaveBeenCalledTimes(2);
    expect(controller.state.problem).toBe("load");
    expect(controller.state.draft).toBeNull();
    expect(saveButton(controller).props.disabled).toBe(true);
    await controller.save();
    expect(client.save).not.toHaveBeenCalled();
  });
});
