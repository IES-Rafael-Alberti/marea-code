import type { ChangeEvent, SubmitEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SkillAuthoringReadResponseSchema, type SkillAuthoringDraft } from "@marea/protocol";

import { skillAuthoringDraftFixture, skillReadFixture } from "./skill-authoring.fixture.js";
import {
  createSkillAuthoringFileOperationHandlers,
  SkillAuthoringEditor,
  draftForBundle,
  skillAuthoringFileImportInput,
} from "./skill-authoring-editor.js";
import type { SkillAuthoringEditorProperties } from "./skill-authoring-editor.js";
import { skillAuthoringEditorPropertiesFixture } from "./skill-authoring-editor.fixture.js";
import { skillAuthoringMessages } from "./skill-authoring-messages.js";
import { skillAuthoringFileExchangeFixture } from "./skill-authoring-view.fixture.js";
import type { SkillAuthoringFileExchange } from "./skill-authoring-files.js";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";

const m = skillAuthoringMessages("en");
const personalSkill = skillReadFixture.skill;
if (personalSkill === null) throw new Error("The authoring fixture must contain a personal skill.");

function editor(patch: Partial<SkillAuthoringEditorProperties> = {}) {
  const current = skillAuthoringEditorPropertiesFixture(patch);
  const { properties } = current;
  const element = <SkillAuthoringEditor {...properties} />;
  return { ...current, element, elements: reviewElements(element) };
}

function deferredExplicitImport(files: SkillAuthoringFileExchange) {
  let resolveImport: ((files: readonly { path: string; content: string }[]) => void) | undefined;
  files.importExplicit = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
  );
  const input = {
    files: [
      {
        name: "SKILL.md",
        size: 1,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
      } as File,
    ],
    value: "selected",
  };
  return {
    input,
    resolveImport: (imported: readonly { path: string; content: string }[]) => {
      resolveImport?.(imported);
    },
  };
}

function deferredUndefined() {
  let resolvePending: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePending = resolve;
  });
  return { promise, resolve: () => resolvePending?.() };
}

describe("skill authoring editor", () => {
  it("converts bundles and extracts explicit relative file input paths", () => {
    expect(draftForBundle(personalSkill)).toEqual(skillAuthoringDraftFixture);
    const file = { name: "SKILL.md", size: 1, webkitRelativePath: "root/SKILL.md" } as File;
    const event = { currentTarget: { files: [file] } } as never as ChangeEvent<HTMLInputElement>;
    expect(skillAuthoringFileImportInput(event)).toEqual([{ file, path: "root/SKILL.md" }]);
    const noFiles = { currentTarget: { files: null } } as ChangeEvent<HTMLInputElement>;
    expect(skillAuthoringFileImportInput(noFiles)).toEqual([]);
  });

  it("edits kind, slug, main/resource files, removes resources and saves", async () => {
    const resourceDraft = {
      ...skillAuthoringDraftFixture,
      files: [...skillAuthoringDraftFixture.files, { content: "one", path: "resources/one.txt" }],
    };
    const current = editor({
      draft: resourceDraft,
      dirty: true,
      validation: { skill: personalSkill },
    });
    const selects = current.elements.filter((item) => item.type === "select");
    selects[0]?.props.onChange?.({ currentTarget: { value: "evaluation" } });
    selects[0]?.props.onChange?.({ currentTarget: { value: "didactic" } });
    expect(current.edit).toHaveBeenCalledWith({ ...resourceDraft, kind: "evaluation" });
    expect(current.edit).toHaveBeenCalledWith({ ...resourceDraft, kind: "didactic" });
    const inputs = current.elements.filter((item) => item.type === "input");
    const slug = inputs.find((item) => item.props.value === "testing");
    slug?.props.onChange?.({ currentTarget: { value: "changed" } });
    expect(current.edit).toHaveBeenCalledWith({ ...resourceDraft, slug: "changed" });
    const paths = inputs.filter(
      (item) => item.props.value === "SKILL.md" || item.props.value === "resources/one.txt",
    );
    paths[1]?.props.onChange?.({ currentTarget: { value: "resources/two.txt" } });
    const textareas = current.elements.filter((item) => item.type === "textarea");
    textareas[0]?.props.onChange?.({ currentTarget: { value: "main changed" } });
    textareas[1]?.props.onChange?.({ currentTarget: { value: "resource changed" } });
    reviewButton(current.elements, m.removeFile).props.onClick?.();
    reviewButton(current.elements, m.validate).props.onClick?.();
    reviewButton(current.elements, m.save).props.onClick?.();
    await Promise.resolve();
    expect(current.validate).toHaveBeenCalledOnce();
    expect(current.save).toHaveBeenCalledWith(personalSkill.digest);
    expect(current.edit.mock.calls.length).toBeGreaterThan(4);
    expect(renderToStaticMarkup(current.element)).toContain(m.validationSuccess);

    const html = renderToStaticMarkup(current.element);
    expect(html).toContain(m.mainFile);
    expect(html).toContain(m.resourceFile);
    expect(html).toContain('rows="12"');
    expect(html).toContain('rows="8"');
    expect(
      current.elements.filter(
        (item) => item.type === "button" && item.props.children === m.removeFile,
      ),
    ).toHaveLength(1);
    expect(html).toContain('aria-labelledby="skill-authoring-editor-heading"');
    expect(html).toContain('for="skill-authoring-editor-slug"');
    expect(html).toContain('id="skill-authoring-editor-slug"');
    expect(html).toContain('for="skill-authoring-editor-kind"');
    expect(html).toContain('id="skill-authoring-editor-kind"');
    expect(html).toContain('id="skill-authoring-editor-file-0-path"');
    expect(html).toContain('for="skill-authoring-editor-file-0-path"');
    expect(html).toContain('id="skill-authoring-editor-file-0-content"');
    expect(html).toContain('for="skill-authoring-editor-file-0-content"');
    expect(html).toContain('id="skill-authoring-editor-file-1-path"');
    expect(html).toContain('for="skill-authoring-editor-file-1-path"');
    expect(html).toContain('id="skill-authoring-editor-file-1-content"');
    expect(html).toContain('for="skill-authoring-editor-file-1-content"');
    expect(html).toContain(m.dirtyNote);
    expect(reviewButton(current.elements, m.validate).props.disabled).toBe(false);

    const updatedFiles = current.edit.mock.calls.find(([next]) =>
      next.files.some((file) => file.path === "resources/two.txt"),
    )?.[0].files;
    expect(updatedFiles).toEqual([
      { content: "Teach one idea.", path: "SKILL.md" },
      { content: "one", path: "resources/two.txt" },
    ]);

    const removeOnly = editor({ draft: resourceDraft });
    reviewButton(removeOnly.elements, m.removeFile).props.onClick?.();
    expect(removeOnly.edit).toHaveBeenCalledWith(skillAuthoringDraftFixture);
  });

  it("handles directory and explicit imports, replacement and errors", async () => {
    const imported = [
      { content: "Imported main", path: "SKILL.md" },
      { content: "new", path: "resources/new.txt" },
    ] as const;
    const clean = editor({ dirty: false });
    clean.files.importDirectory = vi.fn().mockResolvedValue(imported);
    const cleanImport = reviewButton(clean.elements, m.importDirectory).props.onClick as () => void;
    cleanImport();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(clean.edit).toHaveBeenCalledWith({ ...skillAuthoringDraftFixture, files: imported });

    const replace = editor({ dirty: false });
    replace.files.importDirectory = vi
      .fn()
      .mockResolvedValue([{ content: "resource only", path: "resources/only.txt" }]);
    const replaceImport = reviewButton(replace.elements, m.importDirectory).props
      .onClick as () => void;
    replaceImport();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(replace.edit).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ content: "resource only", path: "resources/only.txt" }],
    });

    const dirty = editor({ dirty: true });
    dirty.files.importDirectory = vi.fn().mockResolvedValue(imported);
    reviewButton(dirty.elements, m.importDirectory).props.onClick?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(dirty.edit).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: imported,
    });

    const preserve = editor({
      dirty: true,
      draft: {
        ...skillAuthoringDraftFixture,
        files: [
          ...skillAuthoringDraftFixture.files,
          { content: "keep", path: "resources/keep.txt" },
        ],
      },
    });
    preserve.files.importDirectory = vi
      .fn()
      .mockResolvedValue([{ content: "new", path: "SKILL.md" }]);
    const preserveImport = reviewButton(preserve.elements, m.importDirectory).props
      .onClick as () => void;
    preserveImport();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(preserve.edit).toHaveBeenCalledWith({
      ...preserve.properties.draft,
      files: [{ content: "new", path: "SKILL.md" }],
    });

    const cancelled = editor({ dirty: false });
    cancelled.files.importDirectory = vi.fn().mockResolvedValue(null);
    const cancelledImport = reviewButton(cancelled.elements, m.importDirectory).props
      .onClick as () => void;
    cancelledImport();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(cancelled.edit).not.toHaveBeenCalled();

    const rejected = editor({ dirty: false });
    rejected.files.importDirectory = vi.fn().mockRejectedValue(new Error("cancelled"));
    const rejectedImport = reviewButton(rejected.elements, m.importDirectory).props
      .onClick as () => void;
    rejectedImport();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(rejected.edit).not.toHaveBeenCalled();
    const explicit = rejected.elements.find(
      (item) => item.type === "input" && (item.props as { readonly type?: string }).type === "file",
    );
    const selected = {
      name: "SKILL.md",
      size: 1,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
    } as File;
    const importExplicit = vi
      .spyOn(rejected.files, "importExplicit")
      .mockRejectedValue(new Error("invalid"));
    const explicitTarget = { files: [selected], value: "selected" };
    const explicitChange = explicit?.props.onChange as never as (
      event: ChangeEvent<HTMLInputElement>,
    ) => void;
    explicitChange({ currentTarget: explicitTarget } as never);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(importExplicit).toHaveBeenCalledOnce();
    expect(explicitTarget.value).toBe("");
  });

  it("renders and invokes the explicit dirty-import replace and cancel controls", () => {
    const replaceImport = vi.fn();
    const cancelImport = vi.fn();
    const current = editor({
      fileOperations: {
        error: null,
        exportFile: vi.fn(),
        importDirectory: vi.fn(),
        importExplicit: vi.fn(),
        pendingImport: [{ path: "SKILL.md", content: "incoming" }],
        replaceImport,
        cancelImport,
      },
    });
    reviewButton(current.elements, m.importReplace).props.onClick?.();
    reviewButton(current.elements, m.cancelImport).props.onClick?.();
    expect(replaceImport).toHaveBeenCalledOnce();
    expect(cancelImport).toHaveBeenCalledOnce();
  });

  it("captures explicit files before React clears currentTarget", async () => {
    const current = editor({ dirty: false });
    const { input, resolveImport } = deferredExplicitImport(current.files);
    const event = { currentTarget: input } as never as ChangeEvent<HTMLInputElement>;
    const explicit = current.elements.find(
      (item) => item.type === "input" && (item.props as { readonly type?: string }).type === "file",
    );
    (explicit?.props.onChange as (event: ChangeEvent<HTMLInputElement>) => void)(event);
    (event as never as { currentTarget: null }).currentTarget = null;
    resolveImport([{ content: "Imported", path: "SKILL.md" }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(current.edit).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ content: "Imported", path: "SKILL.md" }],
    });
    expect(input.value).toBe("");
  });

  it("surfaces localized file failures and ignores late imports after context changes", async () => {
    const files = skillAuthoringFileExchangeFixture();
    const onError = vi.fn();
    const onImported = vi.fn();
    const onSuccess = vi.fn();
    let current = true;
    const handlers = createSkillAuthoringFileOperationHandlers(files, {
      begin: () => () => current,
      onError,
      onImported,
      onSuccess,
    });
    handlers.cancelImport();
    handlers.replaceImport();
    expect(onSuccess).not.toHaveBeenCalled();
    files.importDirectory = vi.fn().mockResolvedValue(null);
    handlers.importDirectory();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onSuccess).toHaveBeenCalledOnce();
    files.importExplicit = vi.fn().mockResolvedValue([{ path: "SKILL.md", content: "ok" }]);
    handlers.importExplicit({
      currentTarget: {
        files: [
          { name: "SKILL.md", size: 1, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) },
        ],
        value: "selected",
      },
    } as never);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onSuccess).toHaveBeenCalledTimes(2);
    files.exportFile = vi.fn().mockResolvedValue(undefined);
    handlers.exportFile("SKILL.md", "ok", true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onSuccess).toHaveBeenCalledTimes(3);
    files.importDirectory = vi.fn().mockRejectedValue(new Error("directory"));
    handlers.importDirectory();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledOnce();
    files.exportFile = vi.fn().mockRejectedValue(new Error("export"));
    handlers.exportFile("SKILL.md", "text", false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledTimes(2);
    const lateExport = deferredUndefined();
    files.exportFile = vi.fn().mockReturnValue(lateExport.promise);
    handlers.exportFile("SKILL.md", "late", false);
    current = false;
    lateExport.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onSuccess).toHaveBeenCalledTimes(3);
    const lateSuccess = deferredExplicitImport(files);
    handlers.importExplicit({ currentTarget: lateSuccess.input } as never);
    current = false;
    lateSuccess.resolveImport([{ content: "late", path: "SKILL.md" }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onSuccess).toHaveBeenCalledTimes(3);

    const { input, resolveImport } = deferredExplicitImport(files);
    onImported.mockClear();
    handlers.importExplicit({ currentTarget: input } as never);
    current = false;
    resolveImport([{ content: "late", path: "SKILL.md" }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(onImported).not.toHaveBeenCalled();
    expect(input.value).toBe("");

    const failed = editor({
      fileOperations: {
        error: m.fileError,
        exportFile: vi.fn(),
        importDirectory: vi.fn(),
        importExplicit: vi.fn(),
        pendingImport: null,
        replaceImport: vi.fn(),
        cancelImport: vi.fn(),
      },
    });
    expect(renderToStaticMarkup(failed.element)).toContain(m.fileError);
  });

  it("exports saved and draft files, including adapter errors, and submits copy", async () => {
    const current = editor({
      copySource: { skillId: "marea/bundled", digest: personalSkill.digest },
      dirty: false,
    });
    reviewButton(current.elements, m.exportSaved("SKILL.md")).props.onClick?.();
    const exportFile = vi
      .spyOn(current.files, "exportFile")
      .mockRejectedValue(new Error("download"));
    const resource = current.elements.find(
      (item) => item.type === "button" && item.props.children === m.exportSaved("SKILL.md"),
    );
    resource?.props.onClick?.();
    class TestFormData {
      get = (): FormDataEntryValue => {
        return "copied";
      };
    }
    vi.stubGlobal("FormData", TestFormData);
    const copyForm = current.elements.find((item) => item.type === "form");
    const onSubmit = (
      copyForm?.props as { onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void }
    ).onSubmit;
    const preventDefault = vi.fn();
    onSubmit?.({ currentTarget: {} as HTMLFormElement, preventDefault } as never);
    vi.unstubAllGlobals();
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(current.copy).toHaveBeenCalledWith("marea/bundled", personalSkill.digest, "copied");
    expect(exportFile).toHaveBeenCalled();
    expect(copyForm?.props.disabled).toBeUndefined();
    expect(
      current.elements.find((item) => item.type === "fieldset" && item.props.disabled === true),
    ).toBeUndefined();

    const disabledCopy = editor({
      blocked: true,
      copySource: { skillId: "marea/bundled", digest: personalSkill.digest },
      dirty: true,
    });
    const disabledForm = disabledCopy.elements.find((item) => item.type === "form");
    vi.stubGlobal("FormData", TestFormData);
    (
      disabledForm?.props as { onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void }
    ).onSubmit?.({
      currentTarget: {} as HTMLFormElement,
      preventDefault: vi.fn(),
    } as never);
    vi.unstubAllGlobals();
    expect(disabledCopy.copy).not.toHaveBeenCalled();

    const emptySlug = editor({
      copySource: { skillId: "marea/bundled", digest: personalSkill.digest },
      dirty: false,
    });
    class EmptyFormData {
      get = (): FormDataEntryValue | null => {
        return null;
      };
    }
    vi.stubGlobal("FormData", EmptyFormData);
    (
      emptySlug.elements.find((item) => item.type === "form")?.props as {
        onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void;
      }
    ).onSubmit?.({ currentTarget: {} as HTMLFormElement, preventDefault: vi.fn() } as never);
    vi.unstubAllGlobals();
    expect(emptySlug.copy).not.toHaveBeenCalled();

    const busyCopy = editor({
      busy: true,
      copySource: { skillId: "marea/bundled", digest: personalSkill.digest },
      dirty: false,
    });
    expect(reviewButton(busyCopy.elements, m.copyBlocked).props.disabled).toBe(true);
    const blockedCopy = editor({
      blocked: true,
      copySource: { skillId: "marea/bundled", digest: personalSkill.digest },
      dirty: false,
    });
    expect(reviewButton(blockedCopy.elements, m.copyBlocked).props.disabled).toBe(true);
  });

  it("disables writes for readonly, busy, blocked and empty drafts", () => {
    const readonly = editor({ editable: false, dirty: false, copySource: null });
    expect(readonly.elements.find((item) => item.type === "fieldset")?.props.disabled).toBe(true);
    expect(reviewButton(readonly.elements, m.saveBlocked).props.disabled).toBe(true);
    expect(reviewButton(readonly.elements, m.validate).props.disabled).toBe(true);
    const busy = editor({ busy: true, dirty: true });
    expect(reviewButton(busy.elements, m.saveBlocked).props.disabled).toBe(true);
    const blocked = editor({ blocked: true, dirty: true });
    expect(reviewButton(blocked.elements, m.saveBlocked).props.disabled).toBe(true);
    const emptyDraft = { ...skillAuthoringDraftFixture, files: [] } as SkillAuthoringDraft;
    const empty = editor({ draft: emptyDraft, dirty: true });
    expect(reviewButton(empty.elements, m.validate).props.disabled).toBe(true);
  });

  it("renders evaluation metadata and draft-only content without a saved bundle", () => {
    const response = SkillAuthoringReadResponseSchema.parse({
      ...skillReadFixture,
      skill: { ...personalSkill, kind: "evaluation", criteria: [] },
    });
    const evaluation = editor({ loadedBundle: response.skill, dirty: false });
    const evaluationHtml = renderToStaticMarkup(evaluation.element);
    const metadata = /<dl class="skill-authoring-metadata">[\s\S]*?<\/dl>/.exec(
      evaluationHtml,
    )?.[0];
    expect(metadata).toContain(m.evaluation);
    expect(metadata).not.toContain(m.didactic);
    expect(evaluationHtml).toContain('id="skill-authoring-editor-heading"');
    const draftOnly = editor({ loadedBundle: null, dirty: true, validation: null });
    const draftOnlyHtml = renderToStaticMarkup(draftOnly.element);
    expect(draftOnlyHtml).toContain(m.draftContent);
    expect(draftOnlyHtml).not.toContain(m.savedContent);
    expect(draftOnlyHtml).not.toContain("skill-authoring-metadata");
    expect(draftOnlyHtml).toContain(m.dirtyNote);
    expect(renderToStaticMarkup(editor({ dirty: false }).element)).not.toContain(m.dirtyNote);
    expect(renderToStaticMarkup(editor({ validation: null }).element)).not.toContain(
      m.validationSuccess,
    );

    const didacticBundle = editor({ loadedBundle: personalSkill, dirty: false });
    const didacticHtml = renderToStaticMarkup(didacticBundle.element);
    const didacticMetadata = /<dl class="skill-authoring-metadata">[\s\S]*?<\/dl>/.exec(
      didacticHtml,
    )?.[0];
    expect(didacticMetadata).toContain(m.didactic);
    expect(didacticMetadata).not.toContain(m.evaluation);
  });
});
