import { ConversationEvent } from "../sessions/conversation-events.js";
import { sessionsMessages } from "../sessions/sessions-messages.js";
import type { DashboardLocale } from "../../messages.js";
import type { EvaluationController, EvaluationState } from "./evaluation-controller.js";
import { EvaluationEditor } from "./evaluation-editor.js";
import { evaluationMessages } from "./evaluation-messages.js";

export interface EvaluationModuleProperties {
  readonly locale: DashboardLocale;
  readonly state: EvaluationState;
  readonly controller: EvaluationController;
}

export function EvaluationModule({ locale, state, controller }: EvaluationModuleProperties) {
  const m = evaluationMessages(locale);
  const closed = state.sessions?.runs.filter((run) => run.state === "closed") ?? [];
  const nextBeforeRunId = state.sessions?.nextBeforeRunId;
  return (
    <section
      className="dashboard-module evaluation-module"
      aria-labelledby="evaluation-heading"
      aria-busy={state.busy}
    >
      <h2 id="evaluation-heading">{m.heading}</h2>
      {state.busy && <p role="status">{m.busy}</p>}
      {state.error && <p role="alert">{m.error}</p>}
      <div className="evaluation-layout">
        <nav aria-label={m.sessions}>
          <button
            disabled={state.busy}
            onClick={() => {
              void controller.loadSessions();
            }}
          >
            {m.load}
          </button>
          {state.sessions !== null && closed.length === 0 && <p>{m.empty}</p>}
          <ul className="run-list">
            {closed.map((run) => (
              <li className="run-card" key={run.runId}>
                <strong>{run.studentDisplayName}</strong>
                <p>
                  {run.classDisplayName} · {run.projectDisplayName}
                </p>
                <time>{run.closedAt}</time>
                <button
                  disabled={state.busy}
                  aria-current={state.runId === run.runId ? "true" : undefined}
                  onClick={() => {
                    void controller.select(run.runId);
                  }}
                >
                  {m.select}
                </button>
              </li>
            ))}
          </ul>
          {nextBeforeRunId != null && (
            <button
              disabled={state.busy}
              onClick={() => {
                void controller.loadSessions(nextBeforeRunId);
              }}
            >
              {m.more}
            </button>
          )}
        </nav>
        <EvaluationReview locale={locale} state={state} controller={controller} />
      </div>
    </section>
  );
}

export function EvaluationReview({ locale, state, controller }: EvaluationModuleProperties) {
  const m = evaluationMessages(locale);
  const record = state.evaluation;
  return (
    <div>
      {state.runId === null ? (
        <p>{m.choose}</p>
      ) : (
        <>
          <h3>{state.runId}</h3>
          <button
            disabled={state.busy}
            onClick={() => {
              void controller.refresh();
            }}
          >
            {m.refresh}
          </button>
          <p role="status">{record === null ? m.noDraft : m[record.state]}</p>
          {record !== null && (
            <dl className="evaluation-metadata">
              <dt>{m.generation}</dt>
              <dd>{record.generation}</dd>
              <dt>{m.method}</dt>
              <dd>{record.evaluator.id}</dd>
              <dt>{m.frozen}</dt>
              <dd>
                <code>{record.inputDigest}</code>
              </dd>
            </dl>
          )}
          {record?.state === "failed" && <p>{m.failures[record.failure]}</p>}
          {state.draft !== null && (
            <EvaluationEditor
              draft={state.draft}
              disabled={state.busy || state.uncertain || record?.state !== "draft"}
              messages={m}
              edit={(draft) => {
                controller.edit(draft);
              }}
            />
          )}
          <div className="evaluation-actions">
            <button
              disabled={
                state.busy ||
                record?.state === "queued" ||
                record?.state === "running" ||
                state.pendingKind === "approve"
              }
              onClick={() => {
                void controller.generate();
              }}
            >
              {state.pendingKind === "generate" ? m.retry : m.generate}
            </button>
            {record?.state === "draft" && (
              <button
                disabled={state.busy || state.pendingKind === "generate"}
                onClick={() => {
                  void controller.approve();
                }}
              >
                {state.pendingKind === "approve" ? m.retry : m.approve}
              </button>
            )}
          </div>
          <EvaluationEvidence locale={locale} state={state} controller={controller} />
        </>
      )}
    </div>
  );
}

function EvaluationEvidence({ locale, state, controller }: EvaluationModuleProperties) {
  const m = evaluationMessages(locale);
  return (
    <>
      <h3>{m.evidence}</h3>
      {state.history?.events.map((event) => (
        <ConversationEvent key={event.eventId} event={event} messages={sessionsMessages(locale)} />
      ))}
      {state.history?.nextSequence != null && (
        <button
          disabled={state.busy}
          onClick={() => {
            void controller.nextHistory();
          }}
        >
          {m.moreEvidence}
        </button>
      )}
    </>
  );
}
