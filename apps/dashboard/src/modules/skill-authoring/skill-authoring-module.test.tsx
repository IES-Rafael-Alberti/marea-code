import { renderToStaticMarkup } from "react-dom/server";
import type { SubmitEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

import { SkillAuthoringReadResponseSchema, TeachingCatalogEntrySchema } from "@marea/protocol";

import type { SkillAuthoringActions } from "./skill-authoring-contracts.js";
import { skillAuthoringMessages } from "./skill-authoring-messages.js";
import {
  DEFAULT_SKILL_AUTHORING_LIVE_FILE_OPERATIONS,
  SkillAuthoringModule,
  type SkillAuthoringModuleViewProperties,
} from "./skill-authoring-module.js";
import {
  skillAuthoringDraftFixture,
  skillAuthoringStateFixture,
  skillCatalogFixture,
  skillReadFixture,
} from "./skill-authoring.fixture.js";
import {
  skillAuthoringFileExchangeFixture,
  skillAuthoringActionsFixtureForView,
  skillAuthoringViewFixture,
  skillAuthoringViewPropertiesFixture,
} from "./skill-authoring-view.fixture.js";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";

const m = skillAuthoringMessages("en");
const personalSkill = skillReadFixture.skill;
if (personalSkill === null) throw new Error("The authoring fixture must contain a personal skill.");

function view(
  statePatch: Parameters<typeof skillAuthoringStateFixture>[0] = {},
  controller: SkillAuthoringActions = skillAuthoringActionsFixtureForView(),
) {
  return skillAuthoringViewFixture(statePatch, controller);
}

describe("skill authoring module", () => {
  it.each(["en", "es"] as const)(
    "renders accessible %s copy and complete file content",
    (locale) => {
      const bundle = {
        ...personalSkill,
        files: [
          ...personalSkill.files,
          { content: "key,value", path: "resources/data.csv", sizeBytes: 9 },
        ],
      };
      const response = SkillAuthoringReadResponseSchema.parse({
        ...skillReadFixture,
        skill: bundle,
      });
      const html = renderToStaticMarkup(
        <SkillAuthoringModule
          {...skillAuthoringViewPropertiesFixture(undefined, {
            loadedBundle: response.skill,
            draft: null,
            editable: false,
            personalSlug: null,
            selectedSkillId: "marea/bundled",
          })}
          files={skillAuthoringFileExchangeFixture()}
          locale={locale}
        />,
      );
      expect(html).toContain(skillAuthoringMessages(locale).heading);
      expect(html).toContain('aria-labelledby="skill-authoring-heading"');
      expect(html).toContain("Teach one idea.");
      expect(html).toContain("key,value");
      expect(html).toContain(skillAuthoringMessages(locale).readonlyNote);
    },
  );

  it("exercises locale action labels and default file adapter construction", () => {
    expect(DEFAULT_SKILL_AUTHORING_LIVE_FILE_OPERATIONS).toBe(true);
    for (const locale of ["en", "es"] as const) {
      const messages = skillAuthoringMessages(locale);
      expect(messages.exportSaved("SKILL.md")).toContain("SKILL.md");
      expect(messages.exportDraft("SKILL.md")).toContain("SKILL.md");
      expect(messages.copySource("marea/bundled")).toContain("marea/bundled");
      expect(messages.pendingPrompt("class:one")).toContain("class:one");
    }
    const properties = skillAuthoringViewPropertiesFixture(undefined, { busy: false });
    expect(renderToStaticMarkup(<SkillAuthoringModule {...properties} />)).toContain(m.heading);

    const module = SkillAuthoringModule({ ...properties }) as ReactElement<{
      readonly children?: ReactNode;
    }>;
    const view = Children.toArray(module.props.children).find(
      (child) =>
        isValidElement<SkillAuthoringModuleViewProperties>(child) &&
        child.props.controller === properties.controller,
    );
    if (!isValidElement<SkillAuthoringModuleViewProperties>(view)) {
      throw new Error("Expected the module to render its authoring view.");
    }
    expect(view.props.liveFileOperations).toBe(true);
  });

  it("shows loading, empty, error and choose-class states without hidden writes", () => {
    const controller = skillAuthoringActionsFixtureForView();
    const loadClasses = vi.spyOn(controller, "loadClasses");
    const loading = view(
      { classesLoaded: false, classId: null, draft: null, loadedBundle: null },
      controller,
    );
    expect(renderToStaticMarkup(loading.element)).toContain(m.classesLoading);
    expect(renderToStaticMarkup(loading.element)).toContain(m.chooseClass);
    expect(renderToStaticMarkup(loading.element)).not.toContain(m.editorHeading);
    expect(loadClasses).not.toHaveBeenCalled();

    const empty = view({ classes: [], classId: null, draft: null, loadedBundle: null });
    expect(renderToStaticMarkup(empty.element)).toContain(m.classesEmpty);
    const failed = view({ problem: "load" });
    expect(renderToStaticMarkup(failed.element)).toContain(m.errors.load);
    const busy = view({ busy: true });
    expect(renderToStaticMarkup(busy.element)).toContain(m.busy);
    expect(renderToStaticMarkup(busy.element)).toContain('aria-busy="true"');

    expect(
      renderToStaticMarkup(view({ classId: "class:one", catalogLoaded: false }).element),
    ).toContain(m.catalogLoading);
    expect(
      renderToStaticMarkup(
        view({ classId: "class:one", catalogLoaded: true, catalog: [] }).element,
      ),
    ).toContain(m.catalogEmpty);
    const evaluationEntry = TeachingCatalogEntrySchema.parse({
      ...skillCatalogFixture.skills[0],
      id: "center/north/rubric",
      kind: "evaluation",
    });
    expect(
      renderToStaticMarkup(
        view({ catalog: [...skillCatalogFixture.skills, evaluationEntry] }).element,
      ),
    ).toContain(m.evaluation);

    expect(
      renderToStaticMarkup(
        view({ pendingTarget: { kind: "class", classId: "class:two" } }).element,
      ),
    ).toContain("class:two");
    expect(
      renderToStaticMarkup(
        view({ pendingTarget: { kind: "skill", classId: "class:one", skillId: "marea/bundled" } })
          .element,
      ),
    ).toContain("marea/bundled");
  });

  it("connects class/catalog navigation, reload, validation, edit and save actions", () => {
    const { controller, elements } = view({ dirty: true });
    const loadClasses = vi.spyOn(controller, "loadClasses");
    const loadCatalog = vi.spyOn(controller, "loadCatalog");
    const reload = vi.spyOn(controller, "reload");
    const validateDraft = vi.spyOn(controller, "validateDraft");
    const saveDraft = vi.spyOn(controller, "saveDraft");
    const selectClass = vi.spyOn(controller, "selectClass");
    const selectSkill = vi.spyOn(controller, "selectSkill");
    const editDraft = vi.spyOn(controller, "editDraft");
    reviewButton(elements, m.reloadClasses).props.onClick?.();
    reviewButton(elements, m.reloadCatalog).props.onClick?.();
    reviewButton(elements, m.reload).props.onClick?.();
    reviewButton(elements, m.validate).props.onClick?.();
    reviewButton(elements, m.save).props.onClick?.();
    const select = elements.find((item) => item.type === "select");
    select?.props.onChange?.({ currentTarget: { value: "class:two" } });
    const catalogButton = elements.find(
      (item) => item.type === "button" && item.props.children === "bundled",
    );
    catalogButton?.props.onClick?.();
    const textarea = elements.find((item) => item.type === "textarea");
    textarea?.props.onChange?.({ currentTarget: { value: "Edited skill text" } });
    expect(loadClasses).toHaveBeenCalledOnce();
    expect(loadCatalog).toHaveBeenCalledWith("class:one");
    expect(reload).toHaveBeenCalledOnce();
    expect(validateDraft).toHaveBeenCalledOnce();
    expect(saveDraft).toHaveBeenCalledWith("sha256:" + "a".repeat(64));
    expect(selectClass).toHaveBeenCalledWith("class:two");
    expect(selectSkill).toHaveBeenCalledWith("marea/bundled");
    expect(editDraft).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ content: "Edited skill text", path: "SKILL.md" }],
    });
  });

  it("renders personal creation, kind editing and relative file exchange controls", async () => {
    const controller = skillAuthoringActionsFixtureForView();
    const editDraft = vi.spyOn(controller, "editDraft");
    const files = skillAuthoringFileExchangeFixture();
    const importDirectory = vi.spyOn(files, "importDirectory").mockResolvedValue([
      { content: "# Imported", path: "SKILL.md" },
      { content: "resource", path: "resources/one.txt" },
    ]);
    const exportFile = vi.spyOn(files, "exportFile");
    const properties = skillAuthoringViewPropertiesFixture(controller, {
      draft: skillAuthoringDraftFixture,
      dirty: false,
      loadedBundle: null,
      personalSlug: "new-skill",
    });
    const element = (
      <SkillAuthoringModule {...properties} files={files} liveFileOperations={false} />
    );
    const elements = reviewElements(element);
    const kind = elements.find((item) => item.type === "select" && item.props.value === "didactic");
    kind?.props.onChange?.({ currentTarget: { value: "evaluation" } });
    reviewButton(elements, m.importDirectory).props.onClick?.();
    const exportButton = elements.find(
      (item) => item.type === "button" && item.props.children === m.exportDraft("SKILL.md"),
    );
    exportButton?.props.onClick?.();
    await Promise.resolve();
    expect(editDraft).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      kind: "evaluation",
    });
    expect(importDirectory).toHaveBeenCalledOnce();
    expect(exportFile).toHaveBeenCalledWith("SKILL.md", "Teach one idea.", false);
  });

  it("submits personal and copy slugs through explicit forms", () => {
    const controller = skillAuthoringActionsFixtureForView();
    const pending = view({ selectedSkillId: "marea/bundled" }, controller);
    const startPersonalDraft = vi.spyOn(controller, "startPersonalDraft");
    const copySkill = vi.spyOn(controller, "copySkill");
    class TestFormData {
      readonly value = "copied-skill";

      get(name: string): FormDataEntryValue | null {
        return name === "personalSlug" || name === "destinationSlug" ? this.value : null;
      }
    }
    vi.stubGlobal("FormData", TestFormData);
    const forms = pending.elements.filter((item) => item.type === "form");
    for (const form of forms) {
      const onSubmit = (form.props as { onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void })
        .onSubmit;
      onSubmit?.({ currentTarget: {} as HTMLFormElement, preventDefault: vi.fn() } as never);
    }
    vi.unstubAllGlobals();
    const noSlug = view({}, controller);
    class EmptyFormData {
      get = (): FormDataEntryValue | null => {
        return null;
      };
    }
    vi.stubGlobal("FormData", EmptyFormData);
    const personalForm = noSlug.elements.find(
      (item) =>
        item.type === "form" &&
        (item.props as { readonly className?: string }).className ===
          "skill-authoring-personal-form",
    );
    (
      personalForm?.props as { onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void }
    ).onSubmit?.({
      currentTarget: {} as HTMLFormElement,
      preventDefault: vi.fn(),
    } as never);
    vi.unstubAllGlobals();
    expect(startPersonalDraft).toHaveBeenCalledWith("copied-skill");
    expect(copySkill).toHaveBeenCalledWith(
      "marea/bundled",
      "sha256:" + "a".repeat(64),
      "copied-skill",
    );
  });

  it("keeps dirty drafts blocked from copy and shows explicit navigation confirmation", () => {
    const controller = skillAuthoringActionsFixtureForView();
    const confirmNavigation = vi.spyOn(controller, "confirmNavigation");
    const pending = view(
      {
        dirty: true,
        pendingTarget: { kind: "personal", classId: "class:one", slug: "next-skill" },
        selectedSkillId: "marea/bundled",
      },
      controller,
    );
    const html = renderToStaticMarkup(pending.element);
    expect(html).toContain(m.pendingHeading);
    expect(html).toContain(m.pendingPrompt("next-skill"));
    expect(reviewButton(pending.elements, m.discardAndNavigate).props.disabled).toBe(false);
    reviewButton(pending.elements, m.discardAndNavigate).props.onClick?.();
    reviewButton(pending.elements, m.cancelNavigation).props.onClick?.();
    expect(confirmNavigation).toHaveBeenNthCalledWith(1, true);
    expect(confirmNavigation).toHaveBeenNthCalledWith(2, false);
    const save = pending.elements.find(
      (item) =>
        item.type === "button" &&
        (item.props.children === m.save || item.props.children === m.saveBlocked),
    );
    expect(save?.props.disabled).toBe(false);
    const copy = pending.elements.find(
      (item) => item.type === "button" && item.props.children === m.copyBlocked,
    );
    expect(copy?.props.disabled).toBe(true);
  });

  it("renders recovery readback and all write-blocking problem states", () => {
    const recovery = view({ problem: "conflict", recovery: skillReadFixture, dirty: true });
    const acceptReadback = vi.spyOn(recovery.controller, "acceptReadback");
    const html = renderToStaticMarkup(recovery.element);
    expect(html).toContain(m.errors.conflict);
    expect(html).toContain(m.recoveryHeading);
    expect(html).toContain("Teach one idea.");
    expect(html).toContain(m.acceptReadback);
    reviewButton(recovery.elements, m.acceptReadback).props.onClick?.();
    expect(acceptReadback).toHaveBeenCalledOnce();
    for (const problem of ["invalid", "forbidden", "uncertain", "skill-unavailable"] as const) {
      const blocked = view({ problem });
      expect(renderToStaticMarkup(blocked.element)).toContain(m.errors[problem]);
    }
    const missingRecovery = view({ recovery: { ...skillReadFixture, skill: null } });
    expect(renderToStaticMarkup(missingRecovery.element)).toContain(m.noSkill);
    expect(
      renderToStaticMarkup(
        view({
          classId: "class:one",
          draft: null,
          loadedBundle: null,
          personalSlug: null,
          catalog: [],
        }).element,
      ),
    ).toContain(m.chooseSkill);
    expect(
      renderToStaticMarkup(
        view({ classId: "class:one", draft: null, loadedBundle: null, personalSlug: "missing" })
          .element,
      ),
    ).toContain(m.noDraft);
    const richRecovery = SkillAuthoringReadResponseSchema.parse({
      ...skillReadFixture,
      skill: {
        ...personalSkill,
        files: [
          ...personalSkill.files,
          { content: "resource", path: "resources/one.txt", sizeBytes: 8 },
        ],
      },
    });
    expect(renderToStaticMarkup(view({ recovery: richRecovery }).element)).toContain(
      "resources/one.txt",
    );
  });
});
