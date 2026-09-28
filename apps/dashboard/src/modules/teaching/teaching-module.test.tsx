import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TeachingConfigurationResponseSchema } from "@marea/protocol";

import type { TeachingActions } from "./teaching-contracts.js";
import { teachingMessages } from "./teaching-messages.js";
import { TeachingModule } from "./teaching-module.js";
import {
  TEACHING_CATALOG_FIXTURE,
  TEACHING_DIGEST,
  teachingActionsFixture,
  teachingDraftFixture,
  teachingSelectedFixture,
  teachingViewPropertiesFixture,
} from "./teaching-view.fixture.js";
import { teachingReadFixture, teachingStateFixture } from "./teaching.fixture.js";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";

const m = teachingMessages("en");

function setup(
  statePatch: Parameters<typeof teachingStateFixture>[0] = {},
  actions: TeachingActions = teachingActionsFixture(),
) {
  const properties = teachingViewPropertiesFixture(actions, {
    draft: teachingSelectedFixture(),
    catalog: TEACHING_CATALOG_FIXTURE,
    dirty: true,
    ...statePatch,
  });
  return {
    actions,
    properties,
    element: <TeachingModule {...properties} />,
    elements: reviewElements(<TeachingModule {...properties} />),
  };
}

function button(elements: ReturnType<typeof reviewElements>, label: string) {
  return reviewButton(elements, label);
}

describe("teaching module", () => {
  it.each(["en", "es"] as const)("renders accessible %s copy and stable headings", (locale) => {
    const view = (
      <TeachingModule
        locale={locale}
        state={teachingStateFixture({
          draft: teachingSelectedFixture(),
          catalog: TEACHING_CATALOG_FIXTURE,
          dirty: true,
        })}
        controller={teachingActionsFixture()}
      />
    );
    const html = renderToStaticMarkup(view);
    expect(html).toContain(teachingMessages(locale).heading);
    expect(html).toContain('aria-labelledby="teaching-heading"');
    expect(html).toMatchSnapshot();
  });

  it("shows loading, empty and failed class states without inventing a selection", () => {
    const loading = setup({
      classesLoaded: false,
      classId: null,
      configuration: null,
      draft: null,
    });
    expect(renderToStaticMarkup(loading.element)).toContain(m.classesLoading);
    expect(renderToStaticMarkup(loading.element)).not.toContain(m.firstConfiguration);
    expect(renderToStaticMarkup(loading.element)).not.toContain("Guided mode instructions");
    const empty = setup({
      classes: [],
      classId: null,
      configuration: null,
      draft: null,
      catalog: [],
    });
    expect(renderToStaticMarkup(empty.element)).toContain(m.classesEmpty);
    const emptyHtml = renderToStaticMarkup(empty.element);
    expect(emptyHtml).toContain(m.classesEmpty);
    expect(emptyHtml).toContain(m.chooseClass);
    expect(emptyHtml).not.toContain("<label>Class<select");
    const failed = setup({ problem: "load" });
    const failedHtml = renderToStaticMarkup(failed.element);
    expect(failedHtml).toContain(m.problems.load);
    expect(failedHtml.split(m.problems.load).length - 1).toBe(1);
    const busy = renderToStaticMarkup(
      <TeachingModule
        {...teachingViewPropertiesFixture(undefined, {
          busy: true,
          draft: teachingSelectedFixture(),
        })}
      />,
    );
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain(m.busy);
    const busyElements = reviewElements(
      <TeachingModule
        {...teachingViewPropertiesFixture(undefined, {
          busy: true,
          draft: teachingSelectedFixture(),
        })}
      />,
    );
    const busyEditor = busyElements.find(
      (item) =>
        item.type === "fieldset" &&
        ((item.props as { className?: string }).className ?? "").includes("teaching-editor"),
    );
    expect(busyEditor?.props.disabled).toBe(true);
  });

  it("shows a choose-class state instead of a guessed configuration", () => {
    const choose = setup({
      classId: null,
      configuration: null,
      draft: null,
      catalog: [],
    });
    const html = renderToStaticMarkup(choose.element);
    expect(html).toContain(m.chooseClass);
    expect(html).toContain('<option value="" disabled="" selected="">');
    expect(html).not.toContain(m.firstConfiguration);
    expect(html).not.toContain("Guided mode instructions");
  });

  it("distinguishes first configuration from saved versions and unknown classes", () => {
    const first = setup({ configuration: null, draft: teachingDraftFixture() });
    expect(renderToStaticMarkup(first.element)).toContain(m.firstConfiguration);
    const saved = setup();
    expect(renderToStaticMarkup(saved.element)).toContain(m.savedVersion("revision:one"));
    const orphan = setup({
      classes: [{ classId: "class:one", displayName: "Physics" }],
      classId: "class:ghost",
    });
    const orphanHtml = renderToStaticMarkup(orphan.element);
    expect(orphanHtml).toContain("<h3>class:ghost</h3>");
    expect(orphanHtml).not.toContain("<h3>Physics</h3>");
    expect(renderToStaticMarkup(saved.element)).toContain("<h3>Physics</h3>");
  });

  it("connects class loading, selection, save, reload and editor actions to the controller", () => {
    const { actions, elements } = setup();
    const loadClasses = vi.spyOn(actions, "loadClasses");
    const selectClass = vi.spyOn(actions, "selectClass");
    const save = vi.spyOn(actions, "save");
    const reload = vi.spyOn(actions, "reload");
    const edit = vi.spyOn(actions, "edit");
    button(elements, m.reloadClasses).props.onClick?.();
    button(elements, m.save).props.onClick?.();
    button(elements, m.reloadCurrent).props.onClick?.();
    const select = elements.find((item) => item.type === "select");
    select?.props.onChange?.({ currentTarget: { value: "class:two" } });
    const textarea = elements.find((item) => item.type === "textarea");
    textarea?.props.onChange?.({ currentTarget: { value: "Edited instructions" } });
    expect(loadClasses).toHaveBeenCalledOnce();
    expect(selectClass).toHaveBeenCalledWith("class:two");
    expect(save).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    const lastEdit = edit.mock.lastCall?.[0];
    expect(lastEdit?.classInstructions.tutoring).toBe("Edited instructions");
  });

  it("disables saving when busy, clean, unconfigured, blocked or recovering", () => {
    const enabled = setup();
    expect(button(enabled.elements, m.save).props.disabled).toBe(false);
    for (const patch of [
      { busy: true },
      {
        dirty: false,
        configuration: { version: "revision:one", settings: teachingDraftFixture() },
      },
      { operatorReady: false },
      { problem: "conflict" as const },
      { recovery: teachingReadFixture },
      { draft: null },
    ]) {
      const state = teachingStateFixture({
        draft: teachingSelectedFixture(),
        catalog: TEACHING_CATALOG_FIXTURE,
        dirty: true,
        ...(patch.recovery ? { recovery: teachingReadFixture } : patch),
      });
      const view = (
        <TeachingModule locale="en" state={state} controller={teachingActionsFixture()} />
      );
      const elements = reviewElements(view);
      const save = elements.find(
        (item) =>
          item.type === "button" &&
          ((item.props as { children?: string }).children === m.save ||
            (item.props as { children?: string }).children === m.saveBlocked),
      );
      expect(save?.props.disabled).toBe(true);
    }
  });

  it("warns about operator prerequisites without blocking reads", () => {
    const { element } = setup({ operatorReady: false });
    const html = renderToStaticMarkup(element);
    expect(html).toContain(m.operatorWarning);
    expect(html).toContain('class="teaching-warning"');
    expect(html).toContain("Guided mode instructions");
    expect(renderToStaticMarkup(setup().element)).not.toContain(m.operatorWarning);
    const unread = setup({ operatorReady: false, draft: null });
    expect(renderToStaticMarkup(unread.element)).not.toContain(m.operatorWarning);
  });

  it("shows all non-load problems and keeps the draft visible after conflict or uncertainty", () => {
    for (const problem of ["invalid", "forbidden", "unconfigured", "skill-unavailable"] as const) {
      const html = renderToStaticMarkup(setup({ problem }).element);
      expect(html).toContain(m.problems[problem]);
    }
    const blocked = setup({ problem: "uncertain", recovery: null });
    const html = renderToStaticMarkup(blocked.element);
    expect(html).toContain(m.problems.uncertain);
    expect(html).toContain(m.saveBlocked);
    expect(html).toContain("Guided mode instructions");
    const editorFieldset = blocked.elements.find(
      (item) =>
        item.type === "fieldset" &&
        ((item.props as { className?: string }).className ?? "").includes("teaching-editor"),
    );
    expect(editorFieldset?.props.disabled).toBe(true);
    expect(button(blocked.elements, m.reloadCurrent).props.disabled).toBe(false);
    const load = setup({ problem: "load" });
    expect(renderToStaticMarkup(load.element)).not.toContain(m.problems.invalid);
  });

  it("keeps the draft next to a read-only recovery readback with explicit acceptance only", () => {
    const automaticReadback = TeachingConfigurationResponseSchema.parse({
      ...teachingReadFixture,
      configuration: {
        ...teachingReadFixture.configuration,
        settings: teachingSelectedFixture(),
      },
    });
    const recovery = setup({ problem: "conflict", recovery: automaticReadback });
    const html = renderToStaticMarkup(recovery.element);
    const recoveryEditor = recovery.elements.find(
      (item) =>
        item.type === "fieldset" &&
        ((item.props as { className?: string }).className ?? "").includes("teaching-editor"),
    );
    expect(recoveryEditor?.props.disabled).toBe(true);
    expect(html).toContain(m.recoveryHeading);
    expect(html).toContain("Persisted values (read-only)");
    expect(html).toContain("Start from the failed boundary test.");
    expect(html).toContain(TEACHING_DIGEST);
    expect(html).toContain("Guided mode instructions");
    const recoveryButtons = recovery.elements.filter((item) => item.type === "button");
    const discard = recoveryButtons.find(
      (item) => (item.props as { children?: string }).children === m.discardDraft,
    );
    const accept = recoveryButtons.find(
      (item) => (item.props as { children?: string }).children === m.acceptCurrent,
    );
    const acceptReload = vi.spyOn(recovery.actions, "acceptReload");
    discard?.props.onClick?.();
    accept?.props.onClick?.();
    expect(acceptReload).toHaveBeenCalledTimes(2);
    const readbackItems = recovery.elements.filter((item) => item.type === "li");
    expect(readbackItems).toHaveLength(2);
    expect(
      readbackItems.map((item) => {
        const children = (item.props as { children: readonly { props: { children: string } }[] })
          .children;
        const first = children[0];
        if (first === undefined) throw new Error("Expected readback code");
        return first.props.children;
      }),
    ).toEqual(["marea/guided-inquiry", "center/north/laboratory-rubric"]);
    const recovering = setup({ problem: null, recovery: automaticReadback });
    const recoveringEditor = recovering.elements.find(
      (item) =>
        item.type === "fieldset" &&
        ((item.props as { className?: string }).className ?? "").includes("teaching-editor"),
    );
    expect(recoveringEditor?.props.disabled).toBe(true);
    const noCurrent = setup({
      problem: "conflict",
      recovery: TeachingConfigurationResponseSchema.parse({
        ...teachingReadFixture,
        configuration: null,
      }),
    });
    expect(renderToStaticMarkup(noCurrent.element)).toContain(m.noCurrent);
    expect(renderToStaticMarkup(recovery.element)).toContain(m.automaticEvaluation);
  });

  it("requires an explicit dirty-switch confirmation with discard and cancel actions", () => {
    const confirm = setup({
      pendingClassId: "class:two",
      dirty: true,
      classes: [
        { classId: "class:one", displayName: "Physics" },
        { classId: "class:two", displayName: "Mathematics" },
      ],
    });
    const html = renderToStaticMarkup(confirm.element);
    expect(html).toContain(m.switchPrompt("Mathematics"));
    expect(html).toContain('role="alertdialog"');
    const discard = button(confirm.elements, m.switchDiscard);
    const cancel = button(confirm.elements, m.switchCancel);
    const confirmClassSwitch = vi.spyOn(confirm.actions, "confirmClassSwitch");
    discard.props.onClick?.();
    cancel.props.onClick?.();
    expect(confirmClassSwitch).toHaveBeenNthCalledWith(1, true);
    expect(confirmClassSwitch).toHaveBeenNthCalledWith(2, false);
    const orphan = setup({
      pendingClassId: "class:ghost",
      classes: [{ classId: "class:one", displayName: "Physics" }],
      dirty: true,
    });
    expect(renderToStaticMarkup(orphan.element)).toContain(m.switchPrompt("class:ghost"));
    const busySwitch = setup({
      pendingClassId: "class:two",
      dirty: true,
      busy: true,
      classes: [
        { classId: "class:one", displayName: "Physics" },
        { classId: "class:two", displayName: "Mathematics" },
      ],
    });
    expect(button(busySwitch.elements, m.switchDiscard).props.disabled).toBe(true);
  });
});
