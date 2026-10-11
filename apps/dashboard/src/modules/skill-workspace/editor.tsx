import { useState } from "react";
import type { SkillAuthoringDraft } from "@marea/protocol";
import { Markdown } from "../sessions/markdown.js";
import { importSkillFiles } from "./import-files.js";
import { editSkillFields, skillEditorFields, validSkillDraft } from "./draft.boundary.js";
import type { SkillWorkspaceController } from "./controller.js";
import type { SkillWorkspaceMessages } from "./messages.js";

export function SkillEditor({
  controller: c,
  messages: m,
  onReturn,
}: {
  readonly controller: SkillWorkspaceController;
  readonly messages: SkillWorkspaceMessages;
  readonly onReturn: () => void;
}) {
  const [advanced, showAdvanced] = useState(false);
  const [preview, showPreview] = useState(false);
  const [touched, touch] = useState<ReadonlySet<string>>(new Set());
  const [fileError, setFileError] = useState(false);
  const editor = c.editor;
  if (!editor) return null;
  const draft = editor.draft;
  const fields = skillEditorFields(draft);
  const disabled = c.busy || editor.applyPending;
  const change = (next: SkillAuthoringDraft) => {
    c.edit(next);
    setFileError(false);
  };
  const fieldError = (name: string, value: string) =>
    touched.has(name) && value.trim().length === 0;
  const updateFile = (index: number, content: string) => {
    change({
      ...draft,
      files: draft.files.map((file, i) => (i === index ? { ...file, content } : file)),
    });
  };
  const finish = (work: Promise<void>) => {
    void work.then(() => {
      if (c.notice === "saved") onReturn();
    });
  };
  const usage = editor.usage?.uses ?? [];
  return (
    <section className="skills-editor" data-dirty={c.drafts.has(editor.key)}>
      <header className="skills-toolbar">
        <button
          type="button"
          disabled={c.busy}
          onClick={() => {
            c.closeEditor();
            onReturn();
          }}
        >
          {m.back}
        </button>
        <span role="status">{m.draft}</span>
      </header>
      <h2>{editorHeading(fields?.title, m.newSkill)}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          touch(new Set(["title", "description", "instructions"]));
          if (validSkillDraft(draft)) finish(c.save());
          else setFileError(true);
        }}
      >
        <fieldset disabled={disabled}>
          {fields !== null && !advanced ? (
            <>
              {(["title", "description", "instructions"] as const).map((name) => {
                const label =
                  name === "title"
                    ? m.name
                    : name === "description"
                      ? m.description
                      : draft.kind === "didactic"
                        ? m.instructions
                        : m.evaluatorInstructions;
                const invalid = fieldError(name, fields[name]);
                const properties = {
                  id: `skill-${name}`,
                  value: fields[name],
                  "aria-invalid": invalid,
                  onBlur: () => {
                    touch((previous) => new Set([...previous, name]));
                  },
                  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                    change(editSkillFields(draft, { [name]: event.currentTarget.value }));
                  },
                };
                return (
                  <label key={name} htmlFor={`skill-${name}`}>
                    {label}
                    {name === "title" ? (
                      <input {...properties} maxLength={256} />
                    ) : (
                      <textarea
                        {...properties}
                        rows={name === "instructions" ? 14 : 2}
                        maxLength={name === "instructions" ? 262144 : 1024}
                      />
                    )}
                    <span className="skills-field-error">{invalid ? m.required : "\u00a0"}</span>
                  </label>
                );
              })}
              {draft.kind === "didactic" && (
                <details>
                  <summary>
                    {m.criteria} ({fields.criteria.length})
                  </summary>
                  {fields.criteria.map((criterion, index) => (
                    <div key={index} className="skills-criterion">
                      <label>
                        {m.code}
                        <input
                          value={criterion.codigo}
                          maxLength={64}
                          onChange={(event) => {
                            change(
                              editSkillFields(draft, {
                                criteria: fields.criteria.map((item, i) =>
                                  i === index
                                    ? { ...item, codigo: event.currentTarget.value }
                                    : item,
                                ),
                              }),
                            );
                          }}
                        />
                      </label>
                      <label>
                        {m.statement}
                        <textarea
                          value={criterion.enunciado}
                          maxLength={1024}
                          onChange={(event) => {
                            change(
                              editSkillFields(draft, {
                                criteria: fields.criteria.map((item, i) =>
                                  i === index
                                    ? { ...item, enunciado: event.currentTarget.value }
                                    : item,
                                ),
                              }),
                            );
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          change(
                            editSkillFields(draft, {
                              criteria: fields.criteria.filter((_, i) => i !== index),
                            }),
                          );
                        }}
                      >
                        {m.remove}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={fields.criteria.length >= 64}
                    onClick={() => {
                      change(
                        editSkillFields(draft, {
                          criteria: [...fields.criteria, { codigo: "", enunciado: "" }],
                        }),
                      );
                    }}
                  >
                    {m.addCriterion}
                  </button>
                </details>
              )}
            </>
          ) : (
            <>
              {fields === null && <p role="alert">{m.invalid}</p>}
              {draft.files.map((file, index) => (
                <label key={file.path}>
                  {file.path}
                  <textarea
                    rows={file.path === "SKILL.md" ? 20 : 6}
                    value={file.content}
                    onChange={(event) => {
                      updateFile(index, event.currentTarget.value);
                    }}
                  />
                </label>
              ))}
            </>
          )}
          <details>
            <summary>
              {m.resources} ({draft.files.length - 1})
            </summary>
            {draft.files
              .filter((file) => file.path !== "SKILL.md")
              .map((file) => (
                <div className="skills-resource" key={file.path}>
                  <span>{file.path}</span>
                  <button
                    type="button"
                    onClick={() => {
                      change({
                        ...draft,
                        files: draft.files.filter((item) => item.path !== file.path),
                      });
                    }}
                  >
                    {m.remove}
                  </button>
                </div>
              ))}
            <label>
              {m.importFiles}
              <input
                type="file"
                multiple
                accept=".md,.txt,.json,.csv,.yaml,.yml"
                onChange={(event) => {
                  const input = event.currentTarget;
                  const selected = Array.from(input.files ?? [], (file) => ({
                    file,
                    path: file.webkitRelativePath || file.name,
                  }));
                  void importSkillFiles(draft, selected)
                    .then(
                      (imported) => {
                        if (c.editor?.draft === draft) change(imported);
                      },
                      () => {
                        if (c.editor?.draft === draft) setFileError(true);
                      },
                    )
                    .finally(() => {
                      input.value = "";
                    });
                }}
              />
            </label>
          </details>
          {fileError && <p role="alert">{m.invalid}</p>}
        </fieldset>
        <div className="skills-secondary">
          {c.problem === "conflict" && (
            <button
              type="button"
              disabled={c.busy}
              onClick={() => {
                c.copyEditor();
              }}
            >
              {m.copyDraft}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              showAdvanced(!advanced);
            }}
          >
            {advanced ? m.basics : m.advanced}
          </button>
          <button
            type="button"
            onClick={() => {
              showPreview(!preview);
            }}
          >
            {m.preview}
          </button>
          <button
            type="button"
            disabled={c.busy}
            onClick={() => {
              c.discardEditor();
            }}
          >
            {m.discard}
          </button>
        </div>
        {preview && fields && (
          <article className="skills-preview">
            <Markdown text={fields.instructions} />
          </article>
        )}
        <footer className="skills-save-bar">
          <div>
            <p>
              {usage.length > 0
                ? m.impact(
                    usage.filter((item) => item.classroom).length,
                    usage.reduce((total, item) => total + item.students, 0),
                  )
                : m.unused}
            </p>
            <small>{m.future}</small>
          </div>
          {editor.applyPending ? (
            <>
              <button
                type="button"
                disabled={c.busy}
                onClick={() => {
                  void c.reviewApplication();
                }}
              >
                {m.review}
              </button>
              <button
                type="button"
                className="skills-primary"
                disabled={c.busy || editor.usage === null}
                onClick={() => {
                  finish(c.apply());
                }}
              >
                {m.apply}
              </button>
            </>
          ) : (
            <button type="submit" className="skills-primary" disabled={c.busy}>
              {c.busy ? m.working : editor.expectedDigest === null ? m.saveNew : m.save}
            </button>
          )}
        </footer>
      </form>
    </section>
  );
}

function editorHeading(title: string | undefined, fallback: string): string {
  return title === undefined || title === "" ? fallback : title;
}
