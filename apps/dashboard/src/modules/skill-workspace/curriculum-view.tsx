import type { SkillLibraryEntry } from "@marea/protocol";
import { curriculumLabels, curriculumModules } from "./curriculum.js";
import type { SkillWorkspaceMessages } from "./messages.js";

export function CurriculumLabels({
  entry,
  messages,
}: {
  readonly entry: SkillLibraryEntry;
  readonly messages: SkillWorkspaceMessages;
}) {
  const labels = curriculumLabels(entry);
  return (
    <span className="skills-curriculum">
      {labels.length === 0
        ? messages.unlinked
        : labels.map((label) => <span key={label}>{label}</span>)}
    </span>
  );
}
export function CurriculumFilter({
  catalog,
  value,
  change,
  messages: m,
}: {
  readonly catalog: readonly SkillLibraryEntry[];
  readonly value: string;
  readonly change: (value: string) => void;
  readonly messages: SkillWorkspaceMessages;
}) {
  return (
    <label>
      {m.module}
      <select
        value={value}
        onChange={(event) => {
          change(event.currentTarget.value);
        }}
      >
        <option value="">{m.allModules}</option>
        <option value="unlinked">{m.unlinked}</option>
        {curriculumModules(catalog).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
