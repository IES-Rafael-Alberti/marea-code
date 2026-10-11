import type { SkillWorkspaceController } from "./controller.js";
import type { SkillWorkspaceMessages } from "./messages.js";
import { skillEditorFields } from "./draft.boundary.js";
import { Markdown } from "../sessions/markdown.js";
import { createBrowserSkillAuthoringFileExchange } from "../skill-authoring/skill-authoring-files.js";
export function SkillDetail({
  controller: c,
  messages: m,
  assign,
}: {
  readonly controller: SkillWorkspaceController;
  readonly messages: SkillWorkspaceMessages;
  readonly assign: (
    entry: NonNullable<NonNullable<SkillWorkspaceController["detail"]>["skill"]>,
  ) => void;
}) {
  const detail = c.detail;
  const bundle = detail?.skill;
  if (!bundle) return null;
  const fields = skillEditorFields({ ...bundle, slug: bundle.name });
  return (
    <aside className="skills-detail" aria-label={fields?.title ?? bundle.name}>
      <header>
        <h3>{fields?.title ?? bundle.name}</h3>
        <button
          disabled={c.busy}
          onClick={() => {
            c.closeDetail();
          }}
        >
          {m.close}
        </button>
      </header>
      <p>{bundle.description}</p>
      <div className="skills-toolbar">
        <button
          className="skills-primary"
          disabled={c.busy || c.configuration === null}
          onClick={() => {
            assign(bundle);
          }}
        >
          {m.add}
        </button>
        <button
          disabled={c.busy}
          onClick={() => {
            c.editDetail(!detail.editable);
          }}
        >
          {detail.editable ? m.edit : m.copy}
        </button>
      </div>
      <Markdown text={fields?.instructions ?? ""} />
      {bundle.criteria.length > 0 && (
        <details>
          <summary>{m.criteria}</summary>
          <ul>
            {bundle.criteria.map((criterion) => (
              <li key={criterion.code}>
                {criterion.code}: {criterion.statement}
              </li>
            ))}
          </ul>
        </details>
      )}
      <h4>{m.uses}</h4>
      {c.usage?.uses.length === 0 ? (
        <p>{m.unused}</p>
      ) : (
        <ul>
          {c.usage?.uses.map((use) => (
            <li key={use.classId}>
              {use.displayName}: {use.classroom ? m.classroom : ""}
              {use.students > 0 ? ` · ${String(use.students)} ${m.custom}` : ""}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>{m.resources}</summary>
        {bundle.files.map((file) => (
          <p key={file.path}>
            <button
              onClick={() => {
                void c.perform(() =>
                  createBrowserSkillAuthoringFileExchange().exportFile(
                    file.path,
                    file.content,
                    true,
                  ),
                );
              }}
            >
              {m.exportFile}: {file.path}
            </button>
          </p>
        ))}
      </details>
    </aside>
  );
}
