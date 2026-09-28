import type { ReactElement } from "react";
import { formatDateTime, type Locale } from "@marea/i18n";

import type { DashboardState } from "../../dashboard-app.js";
import type { DashboardMessages } from "../../messages.js";

export interface ActiveRunsModuleProperties {
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
    content = (
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
          </li>
        ))}
      </ol>
    );
  }

  return (
    <section aria-live="polite" className="dashboard-module">
      <h2>{messages.activeRunsHeading}</h2>
      {content}
    </section>
  );
}
