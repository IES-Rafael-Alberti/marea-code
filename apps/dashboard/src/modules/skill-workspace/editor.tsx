import { useState } from "react";
import { Markdown } from "../sessions/markdown.js";
import { editSkillMarkdown, skillEditorFields, skillDraftProblem } from "./draft.boundary.js";
import type { SkillWorkspaceController } from "./controller.js";
import type { SkillWorkspaceMessages } from "./messages.js";
import { SkillGeneration } from "./generation.js";

export function SkillEditor({
  controller: c,
  messages: m,
  onReturn,
}: {
  readonly controller: SkillWorkspaceController;
  readonly messages: SkillWorkspaceMessages;
  readonly onReturn: () => void;
}) {
  const [preview, showPreview] = useState(false);
  const [touched, touch] = useState(false);
  const editor = c.editor;
  if (!editor) return null;
  const draft = editor.draft;
  const fields = skillEditorFields(draft);
  const markdown = draft.files.find((file) => file.path === "SKILL.md")?.content ?? "";
  const problem = touched ? skillDraftProblem(draft) : null;
  const disabled = c.busy || editor.applyPending;
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
      <details className="skills-guide">
        <summary>{m.guide}</summary>
        <p>{m.guideHeader}</p>
        <p>{draft.kind === "didactic" ? m.guideDidactic : m.guideEvaluation}</p>
        <p>{m.guideCriteria}</p>
        <p>{m.guideCurriculum}</p>
        <p>{m.guideName}</p>
      </details>
      <SkillGeneration c={c} m={m} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          touch(true);
          if (skillDraftProblem(draft) === null) finish(c.save());
        }}
      >
        <fieldset disabled={disabled}>
          <label htmlFor="skill-markdown">SKILL.md</label>
          <textarea
            id="skill-markdown"
            className="skills-markdown"
            rows={26}
            spellCheck={false}
            value={markdown}
            aria-invalid={problem !== null}
            aria-describedby="skill-markdown-error"
            onBlur={() => {
              touch(true);
            }}
            onChange={(event) => {
              c.edit(
                editSkillMarkdown(draft, event.currentTarget.value, editor.expectedDigest === null),
              );
            }}
          />
          <p id="skill-markdown-error" className="skills-field-error" role="alert">
            {problem === null ? "\u00a0" : m[problem]}
          </p>
          {draft.files.length > 1 && <p>{m.retainedFiles}</p>}
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
            <Markdown text={markdown} />
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
