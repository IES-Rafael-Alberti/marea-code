import {
  completeModeInstructions,
  FREE_INSTRUCTIONS,
  TUTORING_INSTRUCTIONS,
  type TeachingCatalogEntry,
  type TeachingSettings,
} from "@marea/protocol";

import type { TeachingMessages } from "./teaching-messages.js";
import {
  reviewTeachingSelections,
  withToggledRevision,
  withoutRevision,
  type ReviewedTeachingSelection,
} from "./teaching-view-selection.js";

export interface TeachingEditorProperties {
  readonly settings: TeachingSettings;
  readonly catalog: readonly TeachingCatalogEntry[];
  readonly disabled: boolean;
  readonly messages: TeachingMessages;
  readonly edit: (settings: TeachingSettings) => void;
}

/** Editable teaching draft; inactive mode fields and selections are always preserved. */
export function TeachingEditor({
  settings,
  catalog,
  disabled,
  messages: m,
  edit,
}: TeachingEditorProperties) {
  const reviewed = reviewTeachingSelections(settings, catalog);
  const instructions = completeModeInstructions(settings.classInstructions);
  const changeMode = (value: string) => {
    edit({
      ...settings,
      classInstructions: instructions,
      agentMode: value === "tutoring" ? "tutoring" : "free",
    });
  };
  const changeInstruction = (field: "tutoring" | "free", value: string) => {
    edit({ ...settings, classInstructions: { ...instructions, [field]: value } });
  };
  return (
    <fieldset className="teaching-editor" disabled={disabled}>
      <legend className="sr-only">{m.modeLabel}</legend>
      <label>
        {m.modeLabel}
        <select
          value={settings.agentMode}
          onChange={(event) => {
            changeMode(event.currentTarget.value);
          }}
        >
          <option value="tutoring">{m.modes.tutoring}</option>
          <option value="free">{m.modes.free}</option>
        </select>
      </label>
      {settings.agentMode === "tutoring" && (
        <label>
          {m.socraticLabel}
          <select
            value={settings.socraticMode ?? "off"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "off" || value === "normal" || value === "strict")
                edit({ ...settings, socraticMode: value });
            }}
          >
            {(["off", "normal", "strict"] as const).map((mode) => (
              <option key={mode} value={mode}>
                {m.socraticModes[mode]}
              </option>
            ))}
          </select>
          <span className="teaching-note">{m.socraticHelp}</span>
        </label>
      )}
      {settings.agentMode === "free" && <p className="teaching-note">{m.freeModeNote}</p>}
      <details className="teaching-instructions">
        <summary>{m.customizeInstructions}</summary>
        <p className="teaching-note">{m.instructionsNote}</p>
        <label>
          {settings.agentMode === "tutoring" ? m.tutoringInstructions : m.freeInstructions}
          <textarea
            rows={10}
            maxLength={262_144}
            value={instructions[settings.agentMode]}
            onChange={(event) => {
              changeInstruction(settings.agentMode, event.currentTarget.value);
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            changeInstruction(
              settings.agentMode,
              settings.agentMode === "tutoring" ? TUTORING_INSTRUCTIONS : FREE_INSTRUCTIONS,
            );
          }}
        >
          {settings.agentMode === "tutoring" ? m.restoreTutoring : m.restoreFree}
        </button>
      </details>
      <TeachingSkillGroup
        kind="didactic"
        settings={settings}
        available={reviewed.available.didactic}
        selections={reviewed.didactic}
        disabled={disabled}
        messages={m}
        edit={edit}
      />
      <TeachingSkillGroup
        kind="evaluation"
        settings={settings}
        available={reviewed.available.evaluation}
        selections={reviewed.evaluation}
        disabled={disabled}
        messages={m}
        edit={edit}
      />
      <label className="teaching-automatic">
        <input
          type="checkbox"
          checked={settings.automaticEvaluation}
          disabled={disabled || settings.selection.evaluation.length !== 1}
          onChange={(event) => {
            edit({ ...settings, automaticEvaluation: event.currentTarget.checked });
          }}
        />
        {m.automaticEvaluation}
      </label>
      {settings.selection.evaluation.length !== 1 && (
        <p className="teaching-note">{m.automaticEvaluationNote}</p>
      )}
    </fieldset>
  );
}

function TeachingSelectionIssue({
  selection,
  kind,
  settings,
  disabled,
  messages: m,
  edit,
}: {
  readonly selection: ReviewedTeachingSelection;
  readonly kind: "didactic" | "evaluation";
  readonly settings: TeachingSettings;
  readonly disabled: boolean;
  readonly messages: TeachingMessages;
  readonly edit: (settings: TeachingSettings) => void;
}) {
  const entry = selection.entry;
  return (
    <div
      key={`${selection.id}:${selection.digest}`}
      className={`teaching-selection teaching-selection-${selection.status}`}
    >
      <strong>{selection.id}</strong>
      <p>{selection.status === "stale" ? m.skillStale : m.skillMissing}</p>
      <p>
        <code>{selection.digest}</code>
      </p>
      {entry !== null && (
        <button
          disabled={disabled}
          onClick={() => {
            edit(withToggledRevision(settings, kind, { id: entry.id, digest: entry.digest }));
          }}
        >
          {m.reselect}
        </button>
      )}
      <button
        disabled={disabled}
        onClick={() => {
          edit(withoutRevision(settings, kind, selection.id));
        }}
      >
        {m.remove}
      </button>
    </div>
  );
}

function TeachingSkillGroup({
  kind,
  settings,
  available,
  selections,
  disabled,
  messages: m,
  edit,
}: {
  readonly kind: "didactic" | "evaluation";
  readonly settings: TeachingSettings;
  readonly available: readonly TeachingCatalogEntry[];
  readonly selections: readonly ReviewedTeachingSelection[];
  readonly disabled: boolean;
  readonly messages: TeachingMessages;
  readonly edit: (settings: TeachingSettings) => void;
}) {
  const problems = selections.filter((selection) => selection.status !== "current");
  const capReached =
    kind === "didactic"
      ? settings.selection.didactic.length >= 64
      : settings.selection.evaluation.length >= 1;
  return (
    <fieldset className={`teaching-skills teaching-skills-${kind}`} disabled={disabled}>
      <legend>{kind === "didactic" ? m.didacticLegend : m.evaluationLegend}</legend>
      <p>{kind === "didactic" ? m.didacticCap : m.automaticEvaluationNote}</p>
      {problems.map((selection) => (
        <TeachingSelectionIssue
          key={selection.id}
          selection={selection}
          kind={kind}
          settings={settings}
          disabled={disabled}
          messages={m}
          edit={edit}
        />
      ))}
      {available.map((entry) => {
        const checked = settings.selection[kind].some(
          (item) => item.id === entry.id && item.digest === entry.digest,
        );
        return (
          <div className="teaching-skill" key={`${entry.id}:${entry.digest}`}>
            <label>
              <input
                type="checkbox"
                value={`${entry.id}:${entry.digest}`}
                checked={checked}
                disabled={disabled || (!checked && capReached)}
                onChange={() => {
                  edit(withToggledRevision(settings, kind, { id: entry.id, digest: entry.digest }));
                }}
              />
              {entry.name}
            </label>
            <p className="teaching-skill-description">{entry.description}</p>
            <details className="teaching-skill-meta">
              <summary>{m.technicalDetails}</summary>
              {m.source}: {entry.source} · {m.digest}: <code>{entry.digest}</code>
            </details>
          </div>
        );
      })}
    </fieldset>
  );
}
