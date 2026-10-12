import { CurriculumFilter, CurriculumLabels } from "./curriculum-view.js";
import type { Dispatch, SetStateAction } from "react";
import type { SkillLibraryEntry, SkillWorkspaceStudent, TeachingSettings } from "@marea/protocol";
import type { SkillWorkspaceController } from "./controller.js";
import type { SkillWorkspaceMessages } from "./messages.js";
import type { Picker } from "./selection.js";
type Selection = TeachingSettings["selection"]["didactic"];

export function StudentSkills({
  c,
  m,
  query,
  search,
  selected,
  selectStudents,
  personalize,
}: {
  readonly c: SkillWorkspaceController;
  readonly m: SkillWorkspaceMessages;
  readonly query: string;
  readonly search: (value: string) => void;
  readonly selected: readonly string[];
  readonly selectStudents: Dispatch<SetStateAction<readonly string[]>>;
  readonly personalize: (students: readonly SkillWorkspaceStudent[]) => void;
}) {
  return (
    <>
      <div className="skills-toolbar">
        <label>
          {m.studentSearch}
          <input
            type="search"
            value={query}
            onChange={(event) => {
              search(event.currentTarget.value);
            }}
          />
        </label>
        {selected.length > 0 && (
          <button
            disabled={c.busy || c.configuration === null}
            onClick={() => {
              personalize(c.students.filter((item) => selected.includes(item.studentId)));
            }}
          >
            {m.customizeMany} ({selected.length})
          </button>
        )}
      </div>
      {c.students.length === 0 && <p>{m.noStudents}</p>}
      <ul className="skills-students">
        {c.students
          .filter((item) =>
            item.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )
          .map((student) => (
            <li key={student.studentId}>
              <input
                type="checkbox"
                aria-label={student.displayName}
                checked={selected.includes(student.studentId)}
                disabled={
                  c.busy || (!selected.includes(student.studentId) && selected.length >= 100)
                }
                onChange={(event) => {
                  selectStudents(
                    event.currentTarget.checked
                      ? [...selected, student.studentId]
                      : selected.filter((id) => id !== student.studentId),
                  );
                }}
              />
              <div>
                <strong>{student.displayName}</strong>
                <span className="skills-badge">
                  {student.selection === null ? m.inherited : m.custom}
                </span>
                <p>
                  {skillNames(
                    student.selection ?? c.configuration?.settings.selection.didactic ?? [],
                    c.catalog,
                    m.emptyChoice,
                  )}
                </p>
              </div>
              <button
                disabled={c.busy || c.configuration === null}
                onClick={() => {
                  personalize([student]);
                }}
              >
                {m.customize}
              </button>
              {student.selection !== null && (
                <button
                  disabled={c.busy}
                  onClick={() => {
                    void c.assignStudents([student.studentId], null);
                  }}
                >
                  {m.inheritAction}
                </button>
              )}
            </li>
          ))}
      </ul>
    </>
  );
}

export function LibrarySkills({
  module = "",
  filterModule,
  c,
  m,
  query,
  search,
  kind,
  chooseKind,
  tab,
  pick,
  selection,
  source,
  filterSource,
  catalog,
}: {
  readonly module?: string;
  readonly filterModule?: (value: string) => void;
  readonly c: SkillWorkspaceController;
  readonly m: SkillWorkspaceMessages;
  readonly query: string;
  readonly search: (value: string) => void;
  readonly kind: "didactic" | "evaluation";
  readonly chooseKind: (kind: "didactic" | "evaluation") => void;
  readonly tab: string;
  readonly pick: (picker: Picker) => void;
  readonly selection: Selection;
  readonly source: string;
  readonly filterSource: (source: string) => void;
  readonly catalog: readonly SkillLibraryEntry[];
}) {
  return (
    <>
      <div className="skills-toolbar">
        <div className="skills-kind">
          {(["didactic", "evaluation"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={kind === value}
              onClick={() => {
                chooseKind(value);
              }}
            >
              {value === "didactic" ? m.practice : m.evaluation}
            </button>
          ))}
        </div>
        {tab === "classroom" && (
          <button
            disabled={c.busy || c.configuration === null}
            onClick={() => {
              pick({ students: null, initial: selection, kind });
            }}
          >
            {m.add}
          </button>
        )}
      </div>
      {kind === "evaluation" && <p>{m.evaluationHelp}</p>}
      <div className="skills-toolbar">
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
        {filterModule && (
          <CurriculumFilter catalog={c.catalog} value={module} change={filterModule} messages={m} />
        )}
        {tab === "library" && (
          <label>
            {m.library}
            <select
              value={source}
              onChange={(event) => {
                filterSource(event.currentTarget.value);
              }}
            >
              <option value="all">{m.all}</option>
              <option value="teacher">{m.mine}</option>
              <option value="marea">{m.included}</option>
              <option value="center">{m.center}</option>
            </select>
          </label>
        )}
      </div>
      {catalog.length === 0 && <p>{query ? m.noResults : m.empty}</p>}
      <ul className="skills-list">
        {catalog.map((entry) => (
          <li key={entry.id} aria-current={c.detail?.skill?.id === entry.id ? "true" : undefined}>
            <button
              className="skills-open"
              disabled={c.busy}
              onClick={() => {
                void c.open(entry.id);
              }}
            >
              <strong>{entry.title}</strong>
              <span>{entry.description}</span>
              {entry.kind === "didactic" && <CurriculumLabels entry={entry} messages={m} />}
              {c.drafts.has(entry.id) && <small>{m.draft}</small>}
            </button>
            {tab === "classroom" && (
              <button
                disabled={c.busy}
                onClick={() => {
                  void c.assignClass(
                    selection.filter((item) => item.id !== entry.id),
                    kind,
                  );
                }}
              >
                {m.remove}
              </button>
            )}
          </li>
        ))}
      </ul>
      {tab === "classroom" &&
        selection.some((item) => !c.catalog.some((entry) => entry.id === item.id)) && (
          <p role="alert">{m.conflict}</p>
        )}
    </>
  );
}
function skillNames(
  selection: Selection,
  catalog: readonly SkillLibraryEntry[],
  empty: string,
): string {
  return selection.length === 0
    ? empty
    : selection
        .map(
          (item) =>
            catalog.find((entry) => entry.id === item.id)?.title ?? item.id.split("/").at(-1),
        )
        .join(", ");
}
