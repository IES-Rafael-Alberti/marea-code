import { CurriculumLabels, CurriculumFilter } from "./curriculum-view.js";
import { matchesSkill, matchesCurriculum } from "./curriculum.js";
import { useState } from "react";
import type { SkillLibraryEntry, TeachingSettings } from "@marea/protocol";
import type { SkillWorkspaceMessages } from "./messages.js";

type Selection = TeachingSettings["selection"]["didactic"];
/** The catalog never reorders as a checkbox changes, preserving pointer and keyboard position. */
export function SkillSelection({
  catalog,
  initial,
  kind,
  busy,
  title,
  help,
  save,
  close,
  messages: m,
}: {
  readonly catalog: readonly SkillLibraryEntry[];
  readonly initial: Selection;
  readonly kind: "didactic" | "evaluation";
  readonly busy: boolean;
  readonly title: string;
  readonly help?: string;
  readonly save: (selection: Selection) => Promise<void>;
  readonly close: () => void;
  readonly messages: SkillWorkspaceMessages;
}) {
  const [query, search] = useState("");
  const [selection, select] = useState(initial);
  const [module, filterModule] = useState("");
  const available = catalog.filter(
    (item) =>
      item.kind === kind && matchesCurriculum(item, module, catalog) && matchesSkill(item, query),
  );
  return (
    <section className="skills-picker" aria-label={title}>
      <header>
        <h3>{title}</h3>
        <button type="button" disabled={busy} onClick={close}>
          {m.cancel}
        </button>
      </header>
      {help && <p>{help}</p>}
      <label>
        {m.search}
        <input
          type="search"
          value={query}
          onChange={(event) => {
            search(event.currentTarget.value);
          }}
        />
      </label>
      <CurriculumFilter catalog={catalog} value={module} change={filterModule} messages={m} />
      <div className="skills-picker-list">
        {selection
          .filter((item) => !catalog.some((entry) => entry.id === item.id))
          .map((entry) => (
            <label className="skills-choice" key={entry.id}>
              <input
                type="checkbox"
                checked
                disabled={busy}
                onChange={() => {
                  select(selection.filter((item) => item.id !== entry.id));
                }}
              />
              <span>
                {entry.id} · {m.missing}
              </span>
            </label>
          ))}
        {available.length === 0 && <p>{m.noResults}</p>}
        {available.map((entry) => (
          <label className="skills-choice" key={entry.id}>
            <input
              type="checkbox"
              checked={selection.some((item) => item.id === entry.id)}
              disabled={busy}
              onChange={(event) => {
                select(
                  event.currentTarget.checked
                    ? [
                        ...(kind === "evaluation"
                          ? []
                          : selection.filter((item) => item.id !== entry.id)),
                        { id: entry.id, digest: entry.digest },
                      ]
                    : selection.filter((item) => item.id !== entry.id),
                );
              }}
            />
            <span>
              <strong>{entry.title}</strong>
              <span>{entry.description}</span>
              {entry.kind === "didactic" && <CurriculumLabels entry={entry} messages={m} />}
            </span>
          </label>
        ))}
      </div>
      <footer>
        <span>
          {selection.length === 0
            ? kind === "didactic"
              ? m.emptyChoice
              : m.noEvaluation
            : `${String(selection.length)} skills`}
        </span>
        <button
          type="button"
          className="skills-primary"
          disabled={busy || selection.length > 64}
          onClick={() => {
            void save(selection);
          }}
        >
          {busy ? m.working : m.select}
        </button>
      </footer>
    </section>
  );
}

export interface Picker {
  readonly students: readonly string[] | null;
  readonly initial: Selection;
  readonly kind: "didactic" | "evaluation";
}
