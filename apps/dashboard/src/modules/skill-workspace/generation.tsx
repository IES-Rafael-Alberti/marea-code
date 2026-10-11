import { useState } from "react";
import type { SkillWorkspaceController } from "./controller.js";
import type { SkillWorkspaceMessages } from "./messages.js";

/** Generated text is a separate proposal until the teacher explicitly puts it in the editor. */
export function SkillGeneration({
  c,
  m,
}: {
  readonly c: SkillWorkspaceController;
  readonly m: SkillWorkspaceMessages;
}) {
  const [notes, setNotes] = useState("");
  if (!c.editor) return null;
  return (
    <details className="skills-generation">
      <summary>{m.generationTitle}</summary>
      <label>
        {m.generationNotes}
        <textarea
          rows={4}
          value={notes}
          maxLength={16000}
          disabled={c.busy}
          onChange={(event) => {
            setNotes(event.currentTarget.value);
          }}
        />
      </label>
      <button
        type="button"
        disabled={c.busy || c.editor.applyPending || notes.trim().length === 0}
        onClick={() => {
          void c.generate(notes, m.locale);
        }}
      >
        {c.busy ? m.generating : m.generate}
      </button>
      <p>{m.generationHelp}</p>
      {c.generated !== null && (
        <section aria-label={m.generatedTitle}>
          <h3>{m.generatedTitle}</h3>
          <pre className="skills-markdown">{c.generated}</pre>
          <p>{m.generationReplace}</p>
          <button
            type="button"
            disabled={c.busy}
            onClick={() => {
              c.acceptGenerated();
            }}
          >
            {m.useGenerated}
          </button>
          <button
            type="button"
            disabled={c.busy}
            onClick={() => {
              c.discardGenerated();
            }}
          >
            {m.discardGenerated}
          </button>
        </section>
      )}
    </details>
  );
}
