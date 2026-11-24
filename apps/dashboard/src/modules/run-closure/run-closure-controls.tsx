import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Locale } from "@marea/i18n";

import type { RunClosureClient, RunClosureFailure } from "./run-closure-client.boundary.js";
import { ClosureFlow, type ClosurePhase } from "./run-closure-flow.js";
import { runClosureMessages, type RunClosureMessages } from "./run-closure-messages.js";
import "./run-closure.css";

export interface ClosableRun {
  readonly runId: string;
  readonly studentDisplayName: string;
  /** Unknown when the view cannot tell; the warning appears only for a known pending approval. */
  readonly pendingApproval?: boolean;
}

/** React glue: the flow object lives for the component's lifetime and requests a re-render. */
function useClosureFlow(
  perform: (idempotencyKey: string, signal: AbortSignal) => Promise<void>,
  onClosed: () => void,
): ClosureFlow {
  const [, setVersion] = useState(0);
  // Stryker disable next-line ObjectLiteral: the initial value is replaced on the next line before any use.
  const latest = useRef({ perform, onClosed });
  latest.current = { perform, onClosed };
  const flow = useRef<ClosureFlow | null>(null);
  flow.current ??= new ClosureFlow(
    (key, signal) => latest.current.perform(key, signal),
    () => {
      latest.current.onClosed();
    },
    () => {
      setVersion((version) => version + 1);
    },
  );
  const current = flow.current;
  useEffect(
    () => () => {
      current.dispose();
    },
    [current],
  );
  return current;
}

function failureText(m: RunClosureMessages, failure: RunClosureFailure | null): string {
  if (failure === null || failure.kind === "invalid") return m.failed;
  return failure.kind === "server" ? m.serverFailed(failure.requestId) : m[failure.kind];
}

function ClosureDialog({
  idBase,
  locale,
  phase,
  failure,
  title,
  confirmLabel,
  onCancel,
  onConfirm,
  children,
}: {
  /** Distinguishes the dialogs of different runs on one page. */
  readonly idBase: string;
  readonly locale: Locale;
  readonly phase: Exclude<ClosurePhase, "idle">;
  readonly failure: RunClosureFailure | null;
  readonly title: string;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const m = runClosureMessages(locale);
  const titleId = `${idBase}-title`;
  const bodyId = `${idBase}-body`;
  const busy = phase === "busy";
  return (
    <div
      className="closure-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <h3 id={titleId}>{title}</h3>
      <div id={bodyId}>
        {children}
        <p className="closure-note">{m.evaluationNote}</p>
        {phase === "failed" && <p role="alert">{failureText(m, failure)}</p>}
      </div>
      <div className="actions">
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>
          {m.cancel}
        </button>
        <button type="button" className="closure-confirm" disabled={busy} onClick={onConfirm}>
          {busy ? m.ending : confirmLabel}
        </button>
      </div>
    </div>
  );
}

/** Ends one active run after the teacher confirms. */
export function EndSessionControl({
  client,
  locale,
  run,
  onClosed,
}: {
  readonly client: RunClosureClient;
  readonly locale: Locale;
  readonly run: ClosableRun;
  readonly onClosed: () => void;
}): ReactElement {
  const m = runClosureMessages(locale);
  const closure = useClosureFlow(async (key, signal) => {
    await client.closeRun(run.runId, key, signal);
  }, onClosed);
  return (
    <div className="closure-control">
      <button
        type="button"
        className="closure-open"
        onClick={() => {
          closure.open();
        }}
      >
        {m.endSession}
      </button>
      {closure.phase !== "idle" && (
        <ClosureDialog
          idBase={`close-${run.runId}`}
          locale={locale}
          phase={closure.phase}
          failure={closure.failure}
          title={m.oneTitle}
          confirmLabel={m.confirmOne}
          onCancel={() => {
            closure.cancel();
          }}
          onConfirm={() => void closure.confirm()}
        >
          <p>{m.oneBody(run.studentDisplayName)}</p>
          {run.pendingApproval === true && (
            <p className="closure-warning">{m.onePending(run.studentDisplayName)}</p>
          )}
        </ClosureDialog>
      )}
    </div>
  );
}

/** Ends exactly the listed active runs of one class after the teacher reviews who they are. */
export function EndClassSessionsControl({
  client,
  locale,
  classId,
  runs,
  onClosed,
}: {
  readonly client: RunClosureClient;
  readonly locale: Locale;
  readonly classId: string;
  readonly runs: readonly ClosableRun[];
  readonly onClosed: () => void;
}): ReactElement | null {
  const m = runClosureMessages(locale);
  // The list shown in the dialog is the list that is closed, fixed when the dialog opens.
  const [listed, setListed] = useState<readonly ClosableRun[]>([]);
  const closure = useClosureFlow(async (key, signal) => {
    await client.closeClassRuns(
      classId,
      listed.map((run) => run.runId),
      key,
      signal,
    );
  }, onClosed);
  if (runs.length === 0) return null;
  const pending = listed.filter((run) => run.pendingApproval === true);
  return (
    <div className="closure-control">
      <button
        type="button"
        className="closure-open"
        onClick={() => {
          setListed(runs);
          closure.open();
        }}
      >
        {m.endAllSessions}
      </button>
      {closure.phase !== "idle" && (
        <ClosureDialog
          idBase={`close-class-${classId}`}
          locale={locale}
          phase={closure.phase}
          failure={closure.failure}
          title={m.classTitle(listed.length)}
          confirmLabel={m.confirmClass(listed.length)}
          onCancel={() => {
            closure.cancel();
          }}
          onConfirm={() => void closure.confirm()}
        >
          <p>{m.classBody}</p>
          <ul className="closure-students">
            {listed.map((run) => (
              <li key={run.runId}>{run.studentDisplayName}</li>
            ))}
          </ul>
          {pending.length > 0 && (
            <p className="closure-warning">
              {m.classPending(pending.map((run) => run.studentDisplayName).join(", "))}
            </p>
          )}
        </ClosureDialog>
      )}
    </div>
  );
}
