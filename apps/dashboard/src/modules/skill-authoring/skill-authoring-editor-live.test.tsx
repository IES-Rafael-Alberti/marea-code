import { describe, expect, it, vi } from "vitest";

import type { SkillAuthoringDraft } from "@marea/protocol";

import { skillAuthoringDraftFixture } from "./skill-authoring.fixture.js";
import { SkillAuthoringLiveEditor } from "./skill-authoring-editor.js";
import type { SkillAuthoringEditorProperties } from "./skill-authoring-editor.js";
import { skillAuthoringEditorPropertiesFixture } from "./skill-authoring-editor.fixture.js";
import { skillAuthoringMessages } from "./skill-authoring-messages.js";
import { skillAuthoringFileExchangeFixture } from "./skill-authoring-view.fixture.js";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";

type HookValue = boolean | number | string | object | null;
type DraftFile = SkillAuthoringDraft["files"][number];

const liveHookHarness = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  deferEffects: false,
  effectDependencies: [] as (readonly object[] | undefined)[],
  effects: [] as (() => (() => void) | undefined)[],
  errors: [] as (string | null)[],
  stateUpdates: [] as { slot: number; value: HookValue }[],
  stateCursor: 0,
  refs: [] as { current: HookValue }[],
  reuseRefs: false,
  refCursor: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => (() => void) | undefined, dependencies?: readonly object[]) => {
      liveHookHarness.effectDependencies.push(dependencies);
      if (liveHookHarness.deferEffects) {
        liveHookHarness.effects.push(effect);
        return;
      }
      const cleanup = effect();
      if (cleanup !== undefined) liveHookHarness.cleanups.push(cleanup);
    },
    useRef: (initial: HookValue) => {
      if (liveHookHarness.reuseRefs) {
        const existing = liveHookHarness.refs[liveHookHarness.refCursor++];
        if (existing !== undefined) return existing;
      }
      const ref = { current: initial };
      liveHookHarness.refs.push(ref);
      return ref;
    },
    useState: (initial: string | null) => {
      const slot = liveHookHarness.stateCursor++;
      const setState = (value: string | null) => {
        liveHookHarness.errors.push(value);
        liveHookHarness.stateUpdates.push({ slot, value });
      };
      return [initial, setState];
    },
  };
});

const m = skillAuthoringMessages("en");

function deferred<T>() {
  let resolvePending: ((value: T) => void) | undefined;
  let rejectPending: ((reason?: object) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
  });
  return {
    promise,
    reject: (reason: object) => rejectPending?.(reason),
    resolve: (value: T) => resolvePending?.(value),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function liveEditor(patch: Partial<SkillAuthoringEditorProperties> = {}, deferEffect = false) {
  liveHookHarness.cleanups.length = 0;
  liveHookHarness.deferEffects = deferEffect;
  liveHookHarness.effectDependencies.length = 0;
  liveHookHarness.effects.length = 0;
  liveHookHarness.errors.length = 0;
  liveHookHarness.stateUpdates.length = 0;
  liveHookHarness.stateCursor = 0;
  liveHookHarness.refs.length = 0;
  liveHookHarness.reuseRefs = false;
  liveHookHarness.refCursor = 0;
  const current = skillAuthoringEditorPropertiesFixture(patch);
  const { properties } = current;
  const element = <SkillAuthoringLiveEditor {...properties} />;
  return { ...current, element, elements: reviewElements(element) };
}

function currentContextRef(): { current: HookValue } {
  const ref = liveHookHarness.refs[2];
  if (ref === undefined) throw new Error("The live editor should retain a context ref.");
  return ref;
}

function changeContext(patch: Record<string, HookValue>): void {
  const ref = currentContextRef();
  if (ref.current === null || typeof ref.current !== "object") {
    throw new Error("The live editor context should be an object.");
  }
  ref.current = { ...ref.current, ...patch };
}

function fileInput(elements: ReturnType<typeof reviewElements>) {
  const control = elements.find(
    (item) => item.type === "input" && (item.props as { readonly type?: string }).type === "file",
  );
  if (control === undefined) throw new Error("The live editor should expose a file input.");
  return control;
}

function selectedInput() {
  return {
    files: [
      {
        name: "SKILL.md",
        size: 1,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
      } as File,
    ],
    value: "selected",
  };
}

describe("skill authoring live editor", () => {
  it("applies current imports and reports localized operation failures", async () => {
    const current = liveEditor({ dirty: false });
    expect(liveHookHarness.effectDependencies).toEqual([[]]);
    const input = selectedInput();
    const importExplicit = vi
      .spyOn(current.files, "importExplicit")
      .mockResolvedValue([{ content: "Imported", path: "SKILL.md" }]);
    fileInput(current.elements).props.onChange?.({ currentTarget: input });
    await settle();
    expect(importExplicit).toHaveBeenCalledOnce();
    expect(current.edit).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ content: "Imported", path: "SKILL.md" }],
    });
    expect(input.value).toBe("");

    current.files.importDirectory = vi
      .fn()
      .mockResolvedValue([{ content: "Directory", path: "SKILL.md" }]);
    reviewButton(current.elements, m.importDirectory).props.onClick?.();
    await settle();

    current.files.importDirectory = vi.fn().mockRejectedValue(new Error("directory"));
    reviewButton(current.elements, m.importDirectory).props.onClick?.();
    await settle();
    current.files.exportFile = vi.fn().mockResolvedValue(undefined);
    reviewButton(current.elements, m.exportSaved("SKILL.md")).props.onClick?.();
    await settle();
    current.files.exportFile = vi.fn().mockRejectedValue(new Error("export"));
    reviewButton(current.elements, m.exportSaved("SKILL.md")).props.onClick?.();
    await settle();
    expect(liveHookHarness.errors.filter((value) => value !== null)).toEqual([
      m.fileError,
      m.fileError,
    ]);

    const rejected = liveEditor();
    rejected.files.importExplicit = vi.fn().mockRejectedValue(new Error("explicit"));
    const rejectedInput = selectedInput();
    fileInput(rejected.elements).props.onChange?.({ currentTarget: rejectedInput });
    await settle();
    expect(rejectedInput.value).toBe("");
    expect(liveHookHarness.errors.filter((value) => value !== null)).toEqual([m.fileError]);
  });

  it("guards a superseded clean import and clears lifecycle state on rerender", async () => {
    const current = liveEditor({ dirty: false });
    const first = deferred<readonly DraftFile[]>();
    const second = deferred<readonly DraftFile[]>();
    current.files.importDirectory = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const importButton = reviewButton(current.elements, m.importDirectory);
    importButton.props.onClick?.();
    expect(liveHookHarness.stateUpdates.slice(-2)).toEqual([
      { slot: 1, value: null },
      { slot: 0, value: null },
    ]);
    importButton.props.onClick?.();
    first.resolve([{ content: "old", path: "SKILL.md" }]);
    second.resolve([{ content: "new", path: "SKILL.md" }]);
    await settle();
    expect(current.edit).toHaveBeenCalledOnce();
    expect(current.edit).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ content: "new", path: "SKILL.md" }],
    });
    const pending = deferred<readonly DraftFile[]>();
    current.files.importDirectory = vi.fn().mockReturnValue(pending.promise);
    reviewButton(current.elements, m.importDirectory).props.onClick?.();
    const updatesBeforeRerender = liveHookHarness.stateUpdates.length;
    liveHookHarness.reuseRefs = true;
    liveHookHarness.refCursor = 0;
    liveHookHarness.stateCursor = 0;
    SkillAuthoringLiveEditor({ ...current.properties, busy: true });
    liveHookHarness.reuseRefs = false;
    expect(liveHookHarness.stateUpdates.slice(updatesBeforeRerender)).toContainEqual({
      slot: 0,
      value: null,
    });
    pending.resolve([{ content: "late", path: "SKILL.md" }]);
    await settle();
    expect(current.edit).toHaveBeenCalledOnce();
  });

  it("rejects a staged replacement after cancellation and clears its prompt state", async () => {
    const current = liveEditor({ dirty: true });
    const pending = deferred<readonly DraftFile[]>();
    current.files.importDirectory = vi.fn().mockReturnValue(pending.promise);
    liveHookHarness.reuseRefs = true;
    liveHookHarness.refCursor = 0;
    liveHookHarness.stateCursor = 0;
    const rendered = SkillAuthoringLiveEditor(current.properties) as {
      props: {
        fileOperations: {
          importDirectory: () => void;
          cancelImport: () => void;
          replaceImport: () => void;
        };
      };
    };
    rendered.props.fileOperations.importDirectory();
    pending.resolve([{ content: "staged", path: "SKILL.md" }]);
    await settle();
    expect(liveHookHarness.stateUpdates.at(-1)).toEqual({
      slot: 1,
      value: [{ content: "staged", path: "SKILL.md" }],
    });
    rendered.props.fileOperations.cancelImport();
    expect(liveHookHarness.stateUpdates.slice(-2).map(({ value }) => value)).toEqual([null, null]);
    rendered.props.fileOperations.replaceImport();
    expect(current.edit).not.toHaveBeenCalled();
    expect(
      liveHookHarness.stateUpdates.filter(({ value }) => value === null).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("treats the editor as mounted before its first effect callback", async () => {
    const current = liveEditor({ dirty: false }, true);
    const pending = deferred<readonly DraftFile[]>();
    current.files.importDirectory = vi.fn().mockReturnValue(pending.promise);
    reviewButton(current.elements, m.importDirectory).props.onClick?.();
    pending.resolve([{ content: "ready", path: "SKILL.md" }]);
    await settle();
    expect(current.edit).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ content: "ready", path: "SKILL.md" }],
    });
    const effect = liveHookHarness.effects[0];
    if (effect === undefined) throw new Error("The live editor should register its mount effect.");
    const cleanup = effect();
    if (cleanup !== undefined) liveHookHarness.cleanups.push(cleanup);
  });

  it.each([
    ["draft", { dirty: false, draft: { ...skillAuthoringDraftFixture } }],
    ["context key", { dirty: false, contextKey: "changed" }],
    ["loaded bundle", { dirty: false, loadedBundle: null }],
    ["files", { dirty: false, files: skillAuthoringFileExchangeFixture() }],
    ["blocked", { dirty: false, blocked: true }],
    ["busy", { dirty: false, busy: true }],
    ["dirty", { dirty: true }],
    ["editable", { dirty: false, editable: false }],
    ["expected digest", { dirty: false, expectedDigest: "changed" }],
    ["copy source", { dirty: false, copySource: { skillId: "other", digest: "other" } }],
  ] as const)("ignores an import after a %s context change", async (_label, patch) => {
    const current = liveEditor({ dirty: false });
    const pending = deferred<readonly DraftFile[]>();
    current.files.importDirectory = vi.fn().mockReturnValue(pending.promise);
    reviewButton(current.elements, m.importDirectory).props.onClick?.();
    changeContext(patch);
    pending.resolve([{ content: "late", path: "SKILL.md" }]);
    await settle();
    expect(current.edit).not.toHaveBeenCalled();
  });

  it("rejects copy-source, null-context, superseded and unmounted imports", async () => {
    const stable = liveEditor();
    const pendingStable = deferred<readonly DraftFile[]>();
    stable.files.importDirectory = vi.fn().mockReturnValue(pendingStable.promise);
    reviewButton(stable.elements, m.importDirectory).props.onClick?.();
    const stableContext = currentContextRef();
    if (stableContext.current === null || typeof stableContext.current !== "object") {
      throw new Error("The live editor context should be an object.");
    }
    stableContext.current = {
      blocked: stable.properties.blocked,
      busy: stable.properties.busy,
      contextKey: stable.properties.contextKey,
      copySource: stable.properties.copySource,
      dirty: stable.properties.dirty,
      draft: stable.properties.draft,
      editable: stable.properties.editable,
      expectedDigest: stable.properties.expectedDigest,
      files: stable.properties.files,
      loadedBundle: stable.properties.loadedBundle,
    };
    pendingStable.resolve([{ content: "stable", path: "SKILL.md" }]);
    await settle();
    expect(stable.edit).not.toHaveBeenCalled();

    const copySource = liveEditor({ copySource: { skillId: "source", digest: "digest" } });
    const pendingCopy = deferred<readonly DraftFile[]>();
    copySource.files.importDirectory = vi.fn().mockReturnValue(pendingCopy.promise);
    reviewButton(copySource.elements, m.importDirectory).props.onClick?.();
    changeContext({ copySource: { skillId: "source", digest: "changed" } });
    pendingCopy.resolve([{ content: "late", path: "SKILL.md" }]);
    await settle();
    expect(copySource.edit).not.toHaveBeenCalled();

    const changedSkill = liveEditor({ copySource: { skillId: "source", digest: "digest" } });
    const pendingChangedSkill = deferred<readonly DraftFile[]>();
    changedSkill.files.importDirectory = vi.fn().mockReturnValue(pendingChangedSkill.promise);
    reviewButton(changedSkill.elements, m.importDirectory).props.onClick?.();
    changeContext({ copySource: { skillId: "changed", digest: "digest" } });
    pendingChangedSkill.resolve([{ content: "late", path: "SKILL.md" }]);
    await settle();
    expect(changedSkill.edit).not.toHaveBeenCalled();

    const nullContext = liveEditor();
    const pendingNull = deferred<readonly DraftFile[]>();
    nullContext.files.importDirectory = vi.fn().mockReturnValue(pendingNull.promise);
    reviewButton(nullContext.elements, m.importDirectory).props.onClick?.();
    const cancelledContext = liveHookHarness.refs[liveHookHarness.refs.length - 4];
    if (cancelledContext === undefined) throw new Error("Missing cancelled import context ref.");
    cancelledContext.current = null;
    pendingNull.resolve([{ content: "late", path: "SKILL.md" }]);
    await settle();
    expect(nullContext.edit).not.toHaveBeenCalled();

    const superseded = liveEditor();
    const first = deferred<readonly DraftFile[]>();
    const second = deferred<readonly DraftFile[]>();
    superseded.files.importDirectory = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const importButton = reviewButton(superseded.elements, m.importDirectory);
    importButton.props.onClick?.();
    importButton.props.onClick?.();
    first.resolve([{ content: "first", path: "SKILL.md" }]);
    second.resolve([{ content: "second", path: "SKILL.md" }]);
    await settle();
    expect(superseded.edit).not.toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ content: "first", path: "SKILL.md" }],
    });
    expect(superseded.edit).not.toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ content: "second", path: "SKILL.md" }],
    });

    const unmounted = liveEditor();
    const pendingUnmount = deferred<readonly DraftFile[]>();
    unmounted.files.importDirectory = vi.fn().mockReturnValue(pendingUnmount.promise);
    reviewButton(unmounted.elements, m.importDirectory).props.onClick?.();
    const cleanup = liveHookHarness.cleanups[0];
    if (cleanup === undefined) throw new Error("The live editor should register cleanup.");
    cleanup();
    pendingUnmount.resolve([{ content: "late", path: "SKILL.md" }]);
    await settle();
    expect(unmounted.edit).not.toHaveBeenCalled();
  });

  it("ignores stale failures and export completions", async () => {
    const directory = liveEditor();
    const pendingDirectory = deferred<readonly DraftFile[]>();
    directory.files.importDirectory = vi.fn().mockReturnValue(pendingDirectory.promise);
    reviewButton(directory.elements, m.importDirectory).props.onClick?.();
    liveHookHarness.cleanups[0]?.();
    pendingDirectory.reject(new Error("late directory"));
    await settle();
    expect(liveHookHarness.errors.filter((value) => value !== null)).toEqual([]);

    const explicit = liveEditor();
    const pendingExplicit = deferred<readonly DraftFile[]>();
    explicit.files.importExplicit = vi.fn().mockReturnValue(pendingExplicit.promise);
    const explicitInput = selectedInput();
    fileInput(explicit.elements).props.onChange?.({ currentTarget: explicitInput });
    liveHookHarness.cleanups[0]?.();
    pendingExplicit.reject(new Error("late explicit"));
    await settle();
    expect(explicitInput.value).toBe("");
    expect(liveHookHarness.errors.filter((value) => value !== null)).toEqual([]);

    const exportSuccess = liveEditor();
    const pendingExport = deferred<undefined>();
    exportSuccess.files.exportFile = vi.fn().mockReturnValue(pendingExport.promise);
    reviewButton(exportSuccess.elements, m.exportDraft("SKILL.md")).props.onClick?.();
    liveHookHarness.cleanups[0]?.();
    pendingExport.resolve(undefined);
    await settle();
    expect(liveHookHarness.errors.filter((value) => value !== null)).toEqual([]);

    const exportFailure = liveEditor();
    const failedExport = deferred<undefined>();
    exportFailure.files.exportFile = vi.fn().mockReturnValue(failedExport.promise);
    reviewButton(exportFailure.elements, m.exportDraft("SKILL.md")).props.onClick?.();
    liveHookHarness.cleanups[0]?.();
    failedExport.reject(new Error("late export"));
    await settle();
    expect(liveHookHarness.errors.filter((value) => value !== null)).toEqual([]);
  });

  it("stages dirty imports and applies or cancels them only through explicit actions", async () => {
    const current = liveEditor({ dirty: true });
    const pending = deferred<readonly DraftFile[]>();
    current.files.importDirectory = vi.fn().mockReturnValue(pending.promise);
    const rendered = SkillAuthoringLiveEditor(current.properties) as {
      props: {
        fileOperations: {
          importDirectory: () => void;
          replaceImport?: () => void;
          cancelImport?: () => void;
        };
      };
    };
    rendered.props.fileOperations.replaceImport?.();
    rendered.props.fileOperations.importDirectory();
    pending.resolve([{ path: "SKILL.md", content: "incoming" }]);
    await settle();
    rendered.props.fileOperations.replaceImport?.();
    expect(current.edit).toHaveBeenCalledWith({
      ...skillAuthoringDraftFixture,
      files: [{ path: "SKILL.md", content: "incoming" }],
    });
    const pendingGeneration = liveHookHarness.refs[liveHookHarness.refs.length - 1];
    if (pendingGeneration === undefined) throw new Error("Missing pending import generation ref.");
    pendingGeneration.current = null;
    rendered.props.fileOperations.replaceImport?.();

    const cancelled = liveEditor({ dirty: true });
    const pendingCancelled = deferred<readonly DraftFile[]>();
    cancelled.files.importDirectory = vi.fn().mockReturnValue(pendingCancelled.promise);
    const cancelledRendered = SkillAuthoringLiveEditor(cancelled.properties) as {
      props: {
        fileOperations: {
          importDirectory: () => void;
          cancelImport?: () => void;
          replaceImport?: () => void;
        };
      };
    };
    cancelledRendered.props.fileOperations.importDirectory();
    pendingCancelled.resolve([{ path: "SKILL.md", content: "discarded" }]);
    await settle();
    const cancelledContext = liveHookHarness.refs[liveHookHarness.refs.length - 5];
    if (cancelledContext === undefined) throw new Error("Missing cancelled import context ref.");
    cancelledContext.current = null;
    cancelledRendered.props.fileOperations.replaceImport?.();
    cancelledRendered.props.fileOperations.cancelImport?.();
    expect(cancelled.edit).not.toHaveBeenCalled();
  });

  it("revokes an in-flight import when a real hook rerender changes context", async () => {
    const current = liveEditor({ dirty: false });
    const originalContext = currentContextRef().current;
    const pending = deferred<readonly DraftFile[]>();
    current.files.importDirectory = vi.fn().mockReturnValue(pending.promise);
    reviewButton(current.elements, m.importDirectory).props.onClick?.();
    liveHookHarness.reuseRefs = true;
    liveHookHarness.refCursor = 0;
    SkillAuthoringLiveEditor({ ...current.properties, busy: true });
    liveHookHarness.reuseRefs = false;
    currentContextRef().current = originalContext;
    pending.resolve([{ path: "SKILL.md", content: "late" }]);
    await settle();
    expect(current.edit).not.toHaveBeenCalled();
  });

  it("distinguishes changed non-null copy-source digests", async () => {
    const current = liveEditor({
      dirty: false,
      copySource: { skillId: "source", digest: "digest" },
    });
    const pending = deferred<readonly DraftFile[]>();
    current.files.importDirectory = vi.fn().mockReturnValue(pending.promise);
    reviewButton(current.elements, m.importDirectory).props.onClick?.();
    changeContext({ copySource: { skillId: "source", digest: "changed" } });
    pending.resolve([{ path: "SKILL.md", content: "late" }]);
    await settle();
    expect(current.edit).not.toHaveBeenCalled();
  });
});
