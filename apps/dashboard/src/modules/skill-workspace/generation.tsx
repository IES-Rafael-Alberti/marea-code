import { useState } from "react";
import type { SkillWorkspaceController } from "./controller.js";
import type { SkillWorkspaceMessages } from "./messages.js";

/** Generation updates the unsaved editor, with a reversible snapshot of the previous draft. */
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
      {c.beforeGeneration !== null && (
        <button
          type="button"
          disabled={c.busy || c.editor.applyPending}
          onClick={() => {
            c.undoGeneration();
          }}
        >
          {m.undoGeneration}
        </button>
      )}
    </details>
  );
}
