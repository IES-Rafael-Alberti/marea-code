import type { ReactElement } from "react";
import { formatDateTime, type Locale } from "@marea/i18n";

import type { DashboardState } from "../../dashboard-app.js";
import type { DashboardMessages } from "../../messages.js";
import type { RunClosureClient } from "../run-closure/run-closure-client.boundary.js";
import { EndClassSessionsControl, EndSessionControl } from "../run-closure/run-closure-controls.js";

/** Ending sessions is offered only when the host composes a closing client. */
export interface ActiveRunsClosure {
  readonly client: RunClosureClient;
  readonly refresh: () => void;
}

export interface ActiveRunsModuleProperties {
  readonly closure?: ActiveRunsClosure | undefined;
  readonly messages: DashboardMessages;
  readonly state: DashboardState;
  readonly locale?: Locale;
}

function Status({ text }: { readonly text: string }): ReactElement {
  return (
    <div className="module-status">
      <span aria-hidden="true" className="status-dot" />
      <p>{text}</p>
    </div>
  );
}

export function ActiveRunsModule({
  closure,
  messages,
  state,
  locale = "es",
}: ActiveRunsModuleProperties): ReactElement {
  let content: ReactElement;
  if (state.status === "loading") {
    content = <Status text={messages.activeRunsLoading} />;
  } else if (state.status === "failed") {
    content = <Status text={messages.activeRunsError} />;
  } else if (state.response.runs.length === 0) {
    content = <Status text={messages.activeRunsEmpty} />;
  } else {
    const runs = state.response.runs;
    const classes = [...new Map(runs.map((run) => [run.classId, run.classDisplayName]))];
    content = (
      <>
        {closure !== undefined &&
          classes.map(([classId, displayName]) => (
            <div className="class-closure" key={classId}>
              <strong>{displayName}</strong>
              <EndClassSessionsControl
                client={closure.client}
                locale={locale}
                classId={classId}
                runs={runs.filter((run) => run.classId === classId)}
                onClosed={closure.refresh}
              />
            </div>
          ))}
        <ol className="run-list">
          {state.response.runs.map((run) => (
            <li className="run-card" key={run.runId}>
              <strong>{run.studentDisplayName}</strong>
              <dl>
                <div>
                  <dt>{messages.classLabel}</dt>
                  <dd>{run.classDisplayName}</dd>
                </div>
                <div>
                  <dt>{messages.projectLabel}</dt>
                  <dd>{run.projectDisplayName}</dd>
                </div>
                <div>
                  <dt>{messages.lastActivityLabel}</dt>
                  <dd>{formatDateTime(locale, run.lastActivityAt)}</dd>
                </div>
              </dl>
              {run.pendingApproval ? <p className="approval">{messages.approvalPending}</p> : null}
              {closure !== undefined && (
                <EndSessionControl
                  client={closure.client}
                  locale={locale}
                  run={run}
                  onClosed={closure.refresh}
                />
              )}
            </li>
          ))}
        </ol>
      </>
    );
  }

  return (
    <section aria-live="polite" className="dashboard-module">
      <h2>{messages.activeRunsHeading}</h2>
      {content}
    </section>
  );
}
