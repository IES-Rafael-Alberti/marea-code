import type { SkillWorkspaceController } from "./controller.js";
import type { SkillWorkspaceMessages } from "./messages.js";
import { skillEditorFields } from "./draft.boundary.js";
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
          {m.assignSkill}
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
      <pre className="skills-markdown" aria-label="SKILL.md">
        {bundle.files.find((file) => file.path === "SKILL.md")?.content}
      </pre>
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
      {detail.editable &&
        (c.deleting ? (
          <section role="alertdialog" aria-label={m.deleteTitle}>
            <h4>{m.deleteTitle}</h4>
            <p>{m.deleteHelp}</p>
            <p>{m.future}</p>
            <button
              disabled={c.busy}
              onClick={() => {
                c.cancelDeletion();
              }}
            >
              {m.cancel}
            </button>
            <button
              className="skills-danger"
              disabled={c.busy}
              onClick={() => {
                void c.deleteSkill();
              }}
            >
              {m.confirmDelete}
            </button>
          </section>
        ) : (
          <button
            className="skills-danger"
            disabled={c.busy}
            onClick={() => {
              void c.reviewDeletion();
            }}
          >
            {m.deleteTitle}
          </button>
        ))}
    </aside>
  );
}
