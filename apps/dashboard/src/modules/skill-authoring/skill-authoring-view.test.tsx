import type { SubmitEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TeachingCatalogEntrySchema } from "@marea/protocol";

import type { SkillAuthoringActions } from "./skill-authoring-contracts.js";
import { SkillAuthoringEditor, SkillAuthoringLiveEditor } from "./skill-authoring-editor.js";
import {
  resolveSkillAuthoringEditor,
  resolveSkillAuthoringLiveFileOperations,
  skillAuthoringFileContextKey,
  SkillAuthoringView,
} from "./skill-authoring-view.js";
import {
  skillAuthoringDraftFixture,
  skillMissingReadFixture,
  skillAuthoringStateFixture,
  skillCatalogFixture,
  skillReadFixture,
} from "./skill-authoring.fixture.js";
import { skillAuthoringMessages } from "./skill-authoring-messages.js";
import {
  skillAuthoringFileExchangeFixture,
  skillAuthoringActionsFixtureForView,
  skillAuthoringViewPropertiesFixture,
  skillAuthoringViewFixture,
} from "./skill-authoring-view.fixture.js";
import { reviewButton } from "../evaluation/react-tree.fixture.js";

const m = skillAuthoringMessages("en");

function alertCount(html: string): number {
  return html.split('role="alert"').length - 1;
}

function view(
  statePatch: Parameters<typeof skillAuthoringStateFixture>[0] = {},
  controller: SkillAuthoringActions = skillAuthoringActionsFixtureForView(),
) {
  return skillAuthoringViewFixture(statePatch, controller);
}

describe("skill authoring view", () => {
  it("renders catalog selection semantics, class options and navigation locks", () => {
    const selected = view({ selectedSkillId: "marea/bundled" });
    const selectedHtml = renderToStaticMarkup(selected.element);
    expect(selectedHtml).toContain("skill-authoring-catalog-entry-selected");
    expect(selectedHtml).toContain('aria-current="true"');
    expect(selectedHtml).toContain('value="class:one" selected="">Physics</option>');
    expect(
      selected.elements.find((item) => item.type === "select" && item.props.value === "class:one")
        ?.props.disabled,
    ).toBe(false);

    const unselected = view({ selectedSkillId: "other/skill" });
    const unselectedHtml = renderToStaticMarkup(unselected.element);
    expect(unselectedHtml).toContain('<li class="skill-authoring-catalog-entry">');
    expect(unselectedHtml).not.toContain("skill-authoring-catalog-entry-selected");
    expect(unselectedHtml).not.toContain('aria-current="true"');

    expect(reviewButton(selected.elements, "bundled").props.disabled).toBe(false);
    const busy = view({ busy: true });
    expect(reviewButton(busy.elements, "bundled").props.disabled).toBe(true);
    expect(
      busy.elements.find((item) => item.type === "select" && item.props.value === "class:one")
        ?.props.disabled,
    ).toBe(true);

    const pending = view({ pendingTarget: { kind: "class", classId: "class:two" } });
    expect(reviewButton(pending.elements, "bundled").props.disabled).toBe(true);
    expect(
      pending.elements.find((item) => item.type === "select" && item.props.value === "class:one")
        ?.props.disabled,
    ).toBe(true);
  });

  it("renders exact catalog, class and personal status branches", () => {
    const evaluation = TeachingCatalogEntrySchema.parse({
      ...skillCatalogFixture.skills[0],
      id: "center/north/rubric",
      kind: "evaluation",
    });
    const evaluationHtml = renderToStaticMarkup(
      view({
        catalog: [evaluation],
        classId: "class:one",
        draft: null,
        loadedBundle: null,
        personalSlug: null,
      }).element,
    );
    expect(evaluationHtml).toContain(m.evaluation);
    expect(evaluationHtml).not.toContain(m.didactic);
    const didacticHtml = renderToStaticMarkup(
      view({
        catalog: skillCatalogFixture.skills,
        classId: "class:one",
        draft: null,
        loadedBundle: null,
        personalSlug: null,
      }).element,
    );
    expect(didacticHtml).toContain(m.didactic);
    expect(didacticHtml).not.toContain(m.evaluation);

    const noClass = view({ classId: null, draft: null, loadedBundle: null, personalSlug: null });
    const noClassHtml = renderToStaticMarkup(noClass.element);
    expect(noClassHtml).toContain(m.chooseClass);
    expect(noClassHtml).not.toContain(m.catalogHeading);
    expect(noClassHtml).not.toContain(m.chooseSkill);
    expect(noClassHtml).not.toContain(m.noDraft);
    expect(noClassHtml).not.toContain(m.noSkill);
    expect(
      noClass.elements.filter((item) => item.type === "p" && item.props.children === m.chooseClass),
    ).toHaveLength(1);
    expect(
      view().elements.filter((item) => item.type === "p" && item.props.children === m.chooseClass),
    ).toHaveLength(0);

    const noCatalog = view({ catalogLoaded: true, catalog: [] });
    expect(renderToStaticMarkup(noCatalog.element)).toContain(m.catalogEmpty);
    expect(renderToStaticMarkup(view({ catalogLoaded: true }).element)).not.toContain(
      m.catalogEmpty,
    );
    expect(renderToStaticMarkup(view({ catalogLoaded: true }).element)).not.toContain(
      m.classesEmpty,
    );
    expect(renderToStaticMarkup(view({ classesLoaded: false, classes: [] }).element)).not.toContain(
      m.classesEmpty,
    );

    const classNotChosen = view({ classId: null });
    expect(
      classNotChosen.elements.filter((item) => item.type === "select" && item.props.value === ""),
    ).toHaveLength(1);

    const noClassSelector = renderToStaticMarkup(
      view({ classes: [], classId: null, draft: null, loadedBundle: null, personalSlug: null })
        .element,
    );
    expect(noClassSelector).not.toContain("<select");
  });

  it("distinguishes personal reload, draft, readback and blocked-copy states", () => {
    const reloadable = view({ draft: null, loadedBundle: null, personalSlug: "testing" });
    expect(reviewButton(reloadable.elements, m.reload).props.disabled).toBe(false);
    expect(renderToStaticMarkup(reloadable.element)).toContain(
      'name="personalSlug" value="testing"',
    );
    expect(
      renderToStaticMarkup(view({ classId: null, personalSlug: "testing" }).element),
    ).not.toContain(m.reload);
    const noPersonal = view({ draft: null, loadedBundle: null, personalSlug: null });
    expect(
      noPersonal.elements.some(
        (item) => item.type === "button" && item.props.children === m.reload,
      ),
    ).toBe(false);

    const recoveryOnly = view({
      draft: null,
      loadedBundle: null,
      personalSlug: null,
      problem: null,
      recovery: skillReadFixture,
    });
    expect(reviewButton(recoveryOnly.elements, m.reload).props.disabled).toBe(false);
    const uncertainOnly = view({
      draft: null,
      loadedBundle: null,
      personalSlug: null,
      problem: "uncertain",
      recovery: null,
    });
    expect(reviewButton(uncertainOnly.elements, m.reload).props.disabled).toBe(false);
    expect(renderToStaticMarkup(noPersonal.element)).toContain('name="personalSlug" value=""');
    expect(
      renderToStaticMarkup(view({ draft: skillAuthoringDraftFixture, personalSlug: null }).element),
    ).not.toContain(m.chooseSkill);

    const missingDraft = renderToStaticMarkup(
      view({ draft: null, loadedBundle: null, personalSlug: "missing" }).element,
    );
    expect(missingDraft).toContain(m.noDraft);
    expect(missingDraft).toContain(m.noSkill);
    expect(missingDraft).not.toContain(m.chooseSkill);
    expect(
      renderToStaticMarkup(
        view({ classId: null, draft: null, loadedBundle: null, personalSlug: "missing" }).element,
      ),
    ).not.toContain(m.noDraft);
    expect(
      renderToStaticMarkup(
        view({ draft: skillAuthoringDraftFixture, loadedBundle: null, personalSlug: "missing" })
          .element,
      ),
    ).not.toContain(m.noDraft);
    expect(
      renderToStaticMarkup(view({ draft: null, loadedBundle: null, personalSlug: null }).element),
    ).not.toContain(m.noDraft);
    expect(
      renderToStaticMarkup(
        view({ draft: skillAuthoringDraftFixture, loadedBundle: null, personalSlug: "missing" })
          .element,
      ),
    ).not.toContain(m.noSkill);

    const saved = renderToStaticMarkup(
      view({ draft: null, loadedBundle: skillReadFixture.skill }).element,
    );
    expect(saved).not.toContain(m.noSkill);

    for (const problem of ["conflict", "uncertain"] as const) {
      const blocked = view({ dirty: true, problem });
      expect(reviewButton(blocked.elements, m.saveBlocked).props.disabled).toBe(true);
    }
    const recovery = view({ dirty: true, recovery: skillReadFixture });
    expect(reviewButton(recovery.elements, m.saveBlocked).props.disabled).toBe(true);
    expect(reviewButton(view({ dirty: true }).elements, m.save).props.disabled).toBe(false);

    expect(renderToStaticMarkup(view({ selectedSkillId: null }).element)).not.toContain(
      'class="skill-authoring-copy"',
    );
    expect(
      renderToStaticMarkup(view({ selectedSkillId: "marea/bundled", loadedBundle: null }).element),
    ).not.toContain(m.copySource("marea/bundled"));
  });

  it("keeps personal form submission explicit and normalized", () => {
    const controller = skillAuthoringActionsFixtureForView();
    const startPersonalDraft = vi.spyOn(controller, "startPersonalDraft");
    const pending = view({ selectedSkillId: "marea/bundled" }, controller);
    const preventDefault = vi.fn();
    class PaddedFormData {
      get(name: string): FormDataEntryValue | null {
        return name === "personalSlug" || name === "destinationSlug" ? " copied-skill " : null;
      }
    }
    vi.stubGlobal("FormData", PaddedFormData);
    const personalForm = pending.elements.find(
      (item) =>
        item.type === "form" &&
        (item.props as { readonly className?: string }).className ===
          "skill-authoring-personal-form",
    );
    (
      (personalForm?.props as { onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void })
        .onSubmit as ((event: SubmitEvent<HTMLFormElement>) => void) | undefined
    )?.({ currentTarget: {} as HTMLFormElement, preventDefault } as never);
    vi.unstubAllGlobals();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(startPersonalDraft).toHaveBeenCalledWith("copied-skill");

    const noSlugController = skillAuthoringActionsFixtureForView();
    const noSlugStart = vi.spyOn(noSlugController, "startPersonalDraft");
    class EmptyFormData {
      get(): FormDataEntryValue | null {
        return null;
      }
    }
    vi.stubGlobal("FormData", EmptyFormData);
    const noSlug = view({}, noSlugController);
    const noSlugForm = noSlug.elements.find(
      (item) =>
        item.type === "form" &&
        (item.props as { readonly className?: string }).className ===
          "skill-authoring-personal-form",
    );
    (
      (noSlugForm?.props as { onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void })
        .onSubmit as ((event: SubmitEvent<HTMLFormElement>) => void) | undefined
    )?.({ currentTarget: {} as HTMLFormElement, preventDefault: vi.fn() } as never);
    vi.unstubAllGlobals();
    expect(noSlugStart).not.toHaveBeenCalled();
  });

  it("renders readback and error counts without hidden status duplication", () => {
    const loadHtml = renderToStaticMarkup(view({ problem: "load" }).element);
    expect(alertCount(loadHtml)).toBe(1);
    const invalidHtml = renderToStaticMarkup(view({ problem: "invalid" }).element);
    expect(alertCount(invalidHtml)).toBe(1);
    expect(alertCount(renderToStaticMarkup(view({ problem: null }).element))).toBe(0);

    const recoveryHtml = renderToStaticMarkup(
      view({ recovery: skillReadFixture, draft: null, loadedBundle: null, personalSlug: null })
        .element,
    );
    expect(recoveryHtml).toContain(m.mainFile);
    expect(recoveryHtml).toContain("Teach one idea.");
  });

  it.each([
    ["present", skillReadFixture, "Teach one idea."],
    ["missing", skillMissingReadFixture, m.noSkill],
  ] as const)(
    "exposes uncertain-copy recovery reload for %s readback",
    (label, recovery, content) => {
      const controller = skillAuthoringActionsFixtureForView();
      const reloadAction = vi.spyOn(controller, "reload");
      const recovered = view(
        {
          loadedBundle: null,
          personalSlug: null,
          problem: "uncertain",
          recovery,
        },
        controller,
      );
      expect(renderToStaticMarkup(recovered.element)).toContain(content);
      const reload = reviewButton(recovered.elements, m.reload);
      expect(reload.props.disabled).toBe(false);
      reload.props.onClick?.();
      expect(reloadAction).toHaveBeenCalledOnce();
      expect(label).toBeTruthy();
    },
  );

  it("supports explicit live file operations and defaults to the stateless renderer", () => {
    const properties = skillAuthoringViewPropertiesFixture();
    const files = skillAuthoringFileExchangeFixture();
    const base = {
      controller: properties.controller,
      files,
      messages: m,
      state: properties.state,
    };
    expect(renderToStaticMarkup(<SkillAuthoringView {...base} />)).toContain(
      "skill-authoring-editor",
    );
    expect(renderToStaticMarkup(<SkillAuthoringView {...base} liveFileOperations />)).toContain(
      "skill-authoring-editor",
    );
  });

  it("keeps file context keys complete and resolves editor operation modes", () => {
    const complete = skillAuthoringStateFixture({
      problem: "conflict",
      recovery: skillReadFixture,
      selectedSkillId: "marea/bundled",
    });
    expect(skillAuthoringFileContextKey(complete, skillReadFixture.skill)).toBe(
      `class:one|marea/bundled|testing|teacher/t1/testing|sha256:${"a".repeat(64)}|teacher/t1/testing|sha256:${"a".repeat(64)}|conflict`,
    );
    expect(
      skillAuthoringFileContextKey(
        skillAuthoringStateFixture({
          classId: null,
          personalSlug: null,
          problem: null,
          recovery: null,
          selectedSkillId: null,
        }),
        null,
      ),
    ).toBe("|||||||");
    expect(resolveSkillAuthoringLiveFileOperations(undefined)).toBe(false);
    expect(resolveSkillAuthoringLiveFileOperations(true)).toBe(true);
    expect(resolveSkillAuthoringEditor(undefined)).toBe(SkillAuthoringEditor);
    expect(resolveSkillAuthoringEditor(false)).toBe(SkillAuthoringEditor);
    expect(resolveSkillAuthoringEditor(true)).toBe(SkillAuthoringLiveEditor);
  });
});
