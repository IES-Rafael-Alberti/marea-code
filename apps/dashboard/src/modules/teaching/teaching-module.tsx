import "./teaching.css";

import type { TeachingConfigurationResponse } from "@marea/protocol";

import type { TeachingActions, TeachingState } from "./teaching-contracts.js";
import { TeachingEditor } from "./teaching-editor.js";
import type { TeachingMessages } from "./teaching-messages.js";
import { teachingMessages } from "./teaching-messages.js";

import type { TeachingModuleProperties } from "./teaching-contracts.js";

export function TeachingModule({ locale, state, controller }: TeachingModuleProperties) {
  const m = teachingMessages(locale);
  return (
    <section
      className="dashboard-module teaching-module"
      aria-labelledby="teaching-heading"
      aria-busy={state.busy}
    >
      <h2 id="teaching-heading">{m.heading}</h2>
      {state.busy && <p role="status">{m.busy}</p>}
      <TeachingClassesPanel state={state} controller={controller} messages={m} />
      {state.problem !== null && state.problem !== "load" && (
        <p role="alert">{m.problems[state.problem]}</p>
      )}
      {state.draft !== null && !state.operatorReady && (
        <p className="teaching-warning" role="alert">
          {m.operatorWarning}
        </p>
      )}
      {state.classId === null ? (
        <p role="status">{m.chooseClass}</p>
      ) : (
        <TeachingClassConfiguration state={state} controller={controller} messages={m} />
      )}
    </section>
  );
}

function TeachingClassesPanel({
  state,
  controller,
  messages: m,
}: {
  readonly state: TeachingState;
  readonly controller: TeachingActions;
  readonly messages: TeachingMessages;
}) {
  return (
    <>
      <h3>{m.classesHeading}</h3>
      {state.problem === "load" && <p role="alert">{m.problems.load}</p>}
      {!state.classesLoaded && <p role="status">{m.classesLoading}</p>}
      {state.classesLoaded && state.classes.length === 0 && <p role="status">{m.classesEmpty}</p>}
      <div className="teaching-classes">
        <button
          disabled={state.busy}
          onClick={() => {
            void controller.loadClasses();
          }}
        >
          {m.reloadClasses}
        </button>
        {state.classes.length > 0 && (
          <label>
            {m.classSelector}
            <select
              disabled={state.busy || state.pendingClassId !== null}
              value={state.classId ?? ""}
              onChange={(event) => {
                void controller.selectClass(event.currentTarget.value);
              }}
            >
              <option value="" disabled>
                {m.chooseClass}
              </option>
              {state.classes.map((entry) => (
                <option key={entry.classId} value={entry.classId}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </>
  );
}

function TeachingClassConfiguration({
  state,
  controller,
  messages: m,
}: {
  readonly state: TeachingState;
  readonly controller: TeachingActions;
  readonly messages: TeachingMessages;
}) {
  const selected = state.classes.find((entry) => entry.classId === state.classId) ?? null;
  const blocked = state.problem === "conflict" || state.problem === "uncertain";
  const transitioning = state.busy || state.pendingClassId !== null;
  const canSave =
    !transitioning &&
    (state.dirty || state.configuration === null) &&
    !blocked &&
    state.recovery === null &&
    state.operatorReady &&
    state.draft !== null;
  return (
    <div className="teaching-configuration">
      <h3>{selected === null ? state.classId : selected.displayName}</h3>
      <p>
        {state.configuration === null
          ? m.firstConfiguration
          : m.savedVersion(state.configuration.version)}
      </p>
      <p className="teaching-note">{m.saveNote}</p>
      {state.recovery !== null && (
        <TeachingRecovery
          recovery={state.recovery}
          messages={m}
          controller={controller}
          disabled={transitioning}
        />
      )}
      {state.pendingClassId !== null && (
        <section
          className="teaching-switch"
          role="alertdialog"
          aria-labelledby="teaching-switch-heading"
        >
          <h4 id="teaching-switch-heading">
            {m.switchPrompt(
              state.classes.find((entry) => entry.classId === state.pendingClassId)?.displayName ??
                state.pendingClassId,
            )}
          </h4>
          <button
            disabled={state.busy}
            onClick={() => {
              void controller.confirmClassSwitch(true);
            }}
          >
            {m.switchDiscard}
          </button>
          <button
            disabled={state.busy}
            onClick={() => {
              void controller.confirmClassSwitch(false);
            }}
          >
            {m.switchCancel}
          </button>
        </section>
      )}
      <div className="teaching-actions">
        <button
          disabled={state.busy}
          onClick={() => {
            void controller.reload();
          }}
        >
          {m.reloadCurrent}
        </button>
        <button
          disabled={!canSave}
          onClick={() => {
            void controller.save();
          }}
        >
          {blocked ? m.saveBlocked : m.save}
        </button>
      </div>
      {state.draft === null ? (
        <p role="status">{m.noDraft}</p>
      ) : (
        <TeachingEditor
          settings={state.draft}
          catalog={state.catalog}
          disabled={transitioning || blocked || state.recovery !== null}
          messages={m}
          edit={(settings) => {
            controller.edit(settings);
          }}
        />
      )}
    </div>
  );
}

function TeachingRecovery({
  recovery,
  messages: m,
  controller,
  disabled,
}: {
  readonly recovery: TeachingConfigurationResponse;
  readonly messages: TeachingMessages;
  readonly controller: TeachingActions;
  readonly disabled: boolean;
}) {
  const readback = recovery.configuration?.settings ?? null;
  const accept = () => {
    controller.acceptReload();
  };
  return (
    <section className="teaching-recovery" aria-labelledby="teaching-recovery-heading">
      <h4 id="teaching-recovery-heading">{m.recoveryHeading}</h4>
      <p>{m.recoveryNote}</p>
      <div className="teaching-recovery-actions">
        <button disabled={disabled} onClick={accept}>
          {m.discardDraft}
        </button>
        <button disabled={disabled} onClick={accept}>
          {m.acceptCurrent}
        </button>
      </div>
      {readback === null ? (
        <p role="status">{m.noCurrent}</p>
      ) : (
        <div className="teaching-readback">
          <h5>{m.currentValues}</h5>
          <p>{m.modes[readback.agentMode]}</p>
          <pre>{readback.classInstructions.tutoring}</pre>
          <pre>{readback.classInstructions.free}</pre>
          <ul>
            {[...readback.selection.didactic, ...readback.selection.evaluation].map((revision) => (
              <li key={revision.id}>
                <code>{revision.id}</code> <code>{revision.digest}</code>
              </li>
            ))}
          </ul>
          <p>{readback.automaticEvaluation ? m.automaticEvaluation : m.automaticEvaluationNote}</p>
        </div>
      )}
    </section>
  );
}
