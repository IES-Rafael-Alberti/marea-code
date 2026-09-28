import { useEffect, useRef, useState, type ChangeEvent } from "react";

import type { SkillAuthoringDraft, SkillAuthoringReadResponse } from "@marea/protocol";

import type { SkillAuthoringMessages } from "./skill-authoring-messages.js";
import { SkillAuthoringCopyForm } from "./skill-authoring-copy-form.js";
import {
  type SkillAuthoringFileExchange,
  type SkillAuthoringImportFile,
} from "./skill-authoring-files.js";

type SkillBundle = NonNullable<SkillAuthoringReadResponse["skill"]>;
type DraftFiles = SkillAuthoringDraft["files"];

interface SkillAuthoringCopySource {
  readonly skillId: string;
  readonly digest: string;
}

interface SkillAuthoringFileOperationHandlers {
  readonly error: string | null;
  readonly pendingImport: DraftFiles | null;
  readonly replaceImport: () => void;
  readonly cancelImport: () => void;
  readonly exportFile: (path: string, content: string, saved: boolean) => void;
  readonly importDirectory: () => void;
  readonly importExplicit: (event: ChangeEvent<HTMLInputElement>) => void;
}

export interface SkillAuthoringEditorProperties {
  readonly draft: SkillAuthoringDraft;
  readonly loadedBundle: SkillBundle | null;
  readonly editable: boolean;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly expectedDigest: string | null;
  readonly validation: { readonly skill: SkillBundle } | null;
  readonly messages: SkillAuthoringMessages;
  readonly files: SkillAuthoringFileExchange;
  readonly copySource: SkillAuthoringCopySource | null;
  readonly edit: (draft: SkillAuthoringDraft) => void;
  readonly validate: () => Promise<void>;
  readonly save: (expectedDigest: string | null) => Promise<void>;
  readonly copy: (sourceSkillId: string, sourceDigest: string, slug: string) => Promise<void>;
  readonly contextKey?: string;
  readonly fileOperations?: SkillAuthoringFileOperationHandlers;
}

function updateFile(
  draft: SkillAuthoringDraft,
  index: number,
  update: (file: DraftFiles[number]) => DraftFiles[number],
): SkillAuthoringDraft {
  return {
    ...draft,
    files: draft.files.map((file, fileIndex) => (fileIndex === index ? update(file) : file)),
  };
}

function bundleAsDraft(bundle: SkillBundle): SkillAuthoringDraft {
  return {
    files: bundle.files.map(({ path, content }) => ({ path, content })),
    kind: bundle.kind,
    slug: bundle.name,
  };
}

function inputFiles(event: ChangeEvent<HTMLInputElement>): readonly SkillAuthoringImportFile[] {
  return Array.from(event.currentTarget.files ?? [], (file) => ({
    file,
    path: (file as File & { readonly webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

function adoptImportedDraft(draft: SkillAuthoringDraft, imported: DraftFiles): SkillAuthoringDraft {
  return { ...draft, files: imported };
}

export function createSkillAuthoringFileOperationHandlers(
  files: SkillAuthoringFileExchange,
  callbacks: {
    readonly begin: () => () => boolean;
    readonly onError: () => void;
    readonly onImported: (files: DraftFiles) => void;
    readonly onSuccess: () => void;
  },
): SkillAuthoringFileOperationHandlers {
  const importDirectory = () => {
    const isCurrent = callbacks.begin();
    void files.importDirectory().then(
      (imported) => {
        if (!isCurrent()) return;
        if (imported !== null) callbacks.onImported(imported);
        callbacks.onSuccess();
      },
      () => {
        if (isCurrent()) callbacks.onError();
      },
    );
  };

  const importExplicit = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const selectedFiles = inputFiles(event);
    const isCurrent = callbacks.begin();
    void files
      .importExplicit(selectedFiles)
      .then(
        (imported) => {
          if (!isCurrent()) return;
          callbacks.onImported(imported);
          callbacks.onSuccess();
        },
        () => {
          if (isCurrent()) callbacks.onError();
        },
      )
      .finally(() => {
        input.value = "";
      });
  };

  const exportFile = (path: string, content: string, saved: boolean) => {
    const isCurrent = callbacks.begin();
    void files.exportFile(path, content, saved).then(
      () => {
        if (isCurrent()) callbacks.onSuccess();
      },
      () => {
        if (isCurrent()) callbacks.onError();
      },
    );
  };

  return {
    cancelImport: () => undefined,
    error: null,
    importDirectory,
    importExplicit,
    pendingImport: null,
    replaceImport: () => undefined,
    exportFile,
  };
}

interface SkillAuthoringFileContext {
  readonly blocked: boolean;
  readonly busy: boolean;
  readonly copySource: SkillAuthoringCopySource | null;
  readonly contextKey: string | undefined;
  readonly dirty: boolean;
  readonly draft: SkillAuthoringDraft;
  readonly editable: boolean;
  readonly expectedDigest: string | null;
  readonly files: SkillAuthoringFileExchange;
  readonly loadedBundle: SkillBundle | null;
}

function copySourceKey(source: SkillAuthoringCopySource | null): string | null {
  return source === null ? null : `${source.skillId}\u0000${source.digest}`;
}

function sameFileContext(a: SkillAuthoringFileContext, b: SkillAuthoringFileContext): boolean {
  return (
    a.draft === b.draft &&
    a.contextKey === b.contextKey &&
    a.loadedBundle === b.loadedBundle &&
    a.files === b.files &&
    a.blocked === b.blocked &&
    a.busy === b.busy &&
    a.dirty === b.dirty &&
    a.editable === b.editable &&
    a.expectedDigest === b.expectedDigest &&
    copySourceKey(a.copySource) === copySourceKey(b.copySource)
  );
}

function useSkillAuthoringFileOperations(
  properties: SkillAuthoringEditorProperties,
): SkillAuthoringFileOperationHandlers {
  const [error, setError] = useState<string | null>(null);
  const [, setPendingImport] = useState<DraftFiles | null>(null);
  const mountedRef = useRef(true);
  const operationRef = useRef<object | null>(null);
  const contextRef = useRef<SkillAuthoringFileContext | null>(null);
  const generationRef = useRef<object>({});
  const pendingImportRef = useRef<DraftFiles | null>(null);
  const pendingImportContextRef = useRef<SkillAuthoringFileContext | null>(null);
  const pendingImportGenerationRef = useRef<object | null>(null);
  const context: SkillAuthoringFileContext = {
    blocked: properties.blocked,
    busy: properties.busy,
    copySource: properties.copySource,
    contextKey: properties.contextKey,
    dirty: properties.dirty,
    draft: properties.draft,
    editable: properties.editable,
    expectedDigest: properties.expectedDigest,
    files: properties.files,
    loadedBundle: properties.loadedBundle,
  };
  const previousContext = contextRef.current;
  if (previousContext !== null && !sameFileContext(previousContext, context)) {
    generationRef.current = {};
    pendingImportRef.current = null;
    pendingImportContextRef.current = null;
    pendingImportGenerationRef.current = null;
    setError(null);
  }
  contextRef.current = context;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const sameContext = (expected: SkillAuthoringFileContext, generation: object | null): boolean =>
    mountedRef.current &&
    generationRef.current === generation &&
    contextRef.current !== null &&
    sameFileContext(contextRef.current, expected);

  const handlers = createSkillAuthoringFileOperationHandlers(properties.files, {
    begin: () => {
      const operation = {};
      const generation = generationRef.current;
      operationRef.current = operation;
      pendingImportRef.current = null;
      pendingImportContextRef.current = null;
      pendingImportGenerationRef.current = null;
      setPendingImport(null);
      setError(null);
      return () => operationRef.current === operation && sameContext(context, generation);
    },
    onError: () => {
      setError(properties.messages.fileError);
    },
    onImported: (imported) => {
      if (properties.dirty) {
        pendingImportRef.current = imported;
        pendingImportContextRef.current = context;
        pendingImportGenerationRef.current = generationRef.current;
        setPendingImport(imported);
      } else {
        properties.edit(adoptImportedDraft(properties.draft, imported));
      }
    },
    onSuccess: () => undefined,
  });
  return {
    ...handlers,
    cancelImport: () => {
      generationRef.current = {};
      pendingImportRef.current = null;
      pendingImportContextRef.current = null;
      pendingImportGenerationRef.current = null;
      setPendingImport(null);
      setError(null);
    },
    error,
    pendingImport: pendingImportRef.current,
    replaceImport: () => {
      if (pendingImportRef.current === null || pendingImportContextRef.current === null) return;
      const pendingGeneration = pendingImportGenerationRef.current;
      if (!sameContext(pendingImportContextRef.current, pendingGeneration)) return;
      const imported = pendingImportRef.current;
      generationRef.current = {};
      pendingImportRef.current = null;
      pendingImportContextRef.current = null;
      pendingImportGenerationRef.current = null;
      setPendingImport(null);
      setError(null);
      properties.edit(adoptImportedDraft(properties.draft, imported));
    },
  };
}

export function SkillAuthoringLiveEditor(properties: SkillAuthoringEditorProperties) {
  const fileOperations = useSkillAuthoringFileOperations(properties);
  return <SkillAuthoringEditor {...properties} fileOperations={fileOperations} />;
}

export function SkillAuthoringEditor({
  draft,
  loadedBundle,
  editable,
  dirty,
  busy,
  blocked,
  expectedDigest,
  validation,
  messages: m,
  files,
  copySource,
  edit,
  validate,
  save,
  copy,
  fileOperations,
}: SkillAuthoringEditorProperties) {
  const idPrefix = "skill-authoring-editor";
  const editingDisabled = busy || blocked || !editable;
  const writeDisabled = editingDisabled || !dirty;
  const saved = !dirty && loadedBundle !== null;

  const adoptImported = (imported: DraftFiles) => {
    edit(adoptImportedDraft(draft, imported));
  };
  const directFileOperations = createSkillAuthoringFileOperationHandlers(files, {
    begin: () => () => true,
    onError: () => undefined,
    onImported: adoptImported,
    onSuccess: () => undefined,
  });
  const operations = fileOperations ?? directFileOperations;

  return (
    <section className="skill-authoring-editor" aria-labelledby={`${idPrefix}-heading`}>
      <h3 id={`${idPrefix}-heading`}>{m.editorHeading}</h3>
      {loadedBundle !== null && (
        <dl className="skill-authoring-metadata">
          <dt>{m.skillIdentity}</dt>
          <dd>{loadedBundle.id}</dd>
          <dt>{m.source}</dt>
          <dd>{loadedBundle.source}</dd>
          <dt>{m.kind}</dt>
          <dd>{loadedBundle.kind === "didactic" ? m.didactic : m.evaluation}</dd>
          <dt>{m.digest}</dt>
          <dd>
            <code>{loadedBundle.digest}</code>
          </dd>
        </dl>
      )}
      <p className="skill-authoring-content-status">{saved ? m.savedContent : m.draftContent}</p>
      {!editable && <p className="skill-authoring-note">{m.readonlyNote}</p>}
      {dirty && <p className="skill-authoring-note">{m.dirtyNote}</p>}
      <fieldset className="skill-authoring-draft-fields" disabled={editingDisabled}>
        <legend>{m.editable}</legend>
        <label htmlFor={`${idPrefix}-slug`}>{m.slug}</label>
        <input
          id={`${idPrefix}-slug`}
          maxLength={64}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          value={draft.slug}
          onChange={(event) => {
            edit({ ...draft, slug: event.currentTarget.value });
          }}
        />
        <label htmlFor={`${idPrefix}-kind`}>{m.kind}</label>
        <select
          id={`${idPrefix}-kind`}
          value={draft.kind}
          onChange={(event) => {
            edit({
              ...draft,
              kind: event.currentTarget.value === "evaluation" ? "evaluation" : "didactic",
            });
          }}
        >
          <option value="didactic">{m.didactic}</option>
          <option value="evaluation">{m.evaluation}</option>
        </select>
      </fieldset>

      <div className="skill-authoring-file-actions">
        <button disabled={editingDisabled} onClick={operations.importDirectory}>
          {m.importDirectory}
        </button>
        <label className="skill-authoring-file-input">
          {m.importFiles}
          <input
            type="file"
            multiple
            accept=".md,.txt,.json,.csv,.yaml,.yml"
            disabled={editingDisabled}
            onChange={operations.importExplicit}
          />
        </label>
        <p className="skill-authoring-note">{m.importHint}</p>
      </div>
      {operations.pendingImport !== null && (
        <section className="skill-authoring-import-confirmation" role="alertdialog">
          <h4>{m.importPendingHeading}</h4>
          <p>{m.importPendingNote}</p>
          <button disabled={editingDisabled} onClick={operations.replaceImport}>
            {m.importReplace}
          </button>
          <button disabled={busy} onClick={operations.cancelImport}>
            {m.cancelImport}
          </button>
        </section>
      )}
      {operations.error !== null && <p role="alert">{operations.error}</p>}
      <div className="skill-authoring-files" aria-label={m.editorHeading}>
        {draft.files.map((file, index) => {
          const fileId = `${idPrefix}-file-${String(index)}`;
          const isMain = file.path === "SKILL.md";
          return (
            <article className="skill-authoring-file" key={index}>
              <h4>{isMain ? m.mainFile : m.resourceFile}</h4>
              <label htmlFor={`${fileId}-path`}>{m.filePath}</label>
              <input
                id={`${fileId}-path`}
                maxLength={1_024}
                value={file.path}
                disabled={editingDisabled}
                onChange={(event) => {
                  edit(
                    updateFile(draft, index, (current) => ({
                      ...current,
                      path: event.currentTarget.value,
                    })),
                  );
                }}
              />
              <label htmlFor={`${fileId}-content`}>{m.fileContent}</label>
              <textarea
                id={`${fileId}-content`}
                rows={isMain ? 12 : 8}
                maxLength={MAX_TEXT_LENGTH}
                value={file.content}
                disabled={editingDisabled}
                onChange={(event) => {
                  edit(
                    updateFile(draft, index, (current) => ({
                      ...current,
                      content: event.currentTarget.value,
                    })),
                  );
                }}
              />
              <div className="skill-authoring-file-actions">
                <button
                  disabled={busy}
                  onClick={() => {
                    operations.exportFile(file.path, file.content, saved);
                  }}
                >
                  {saved ? m.exportSaved(file.path) : m.exportDraft(file.path)}
                </button>
                {!isMain && (
                  <button
                    disabled={editingDisabled}
                    onClick={() => {
                      edit({
                        ...draft,
                        files: draft.files.filter((_, fileIndex) => fileIndex !== index),
                      });
                    }}
                  >
                    {m.removeFile}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {validation !== null && <p role="status">{m.validationSuccess}</p>}
      <div className="skill-authoring-actions">
        <button
          disabled={editingDisabled || draft.files.length === 0}
          onClick={() => void validate()}
        >
          {m.validate}
        </button>
        <button disabled={writeDisabled} onClick={() => void save(expectedDigest)}>
          {writeDisabled ? m.saveBlocked : m.save}
        </button>
      </div>

      {copySource !== null && (
        <SkillAuthoringCopyForm
          busy={busy}
          blocked={blocked}
          dirty={dirty}
          copySource={copySource}
          copy={copy}
          messages={m}
        />
      )}
    </section>
  );
}

const MAX_TEXT_LENGTH = 524_288;
export const draftForBundle = bundleAsDraft;

export const skillAuthoringFileImportInput = inputFiles;
