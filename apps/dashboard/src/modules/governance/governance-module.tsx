import "./governance.css";
import type { ReactElement } from "react";

import type { DashboardLocale } from "../../messages.js";
import { GovernanceAccountsView } from "./governance-accounts-view.js";
import { GovernanceClassesView } from "./governance-classes-view.js";
import type {
  GovernanceControllerActions,
  GovernanceState,
} from "./governance-controller-contracts.js";
import { governanceMessages } from "./governance-messages.js";
import { PendingSwitch } from "./governance-view-parts.js";

export interface GovernanceModuleProperties {
  readonly locale: DashboardLocale;
  readonly state: GovernanceState;
  readonly controller: GovernanceControllerActions;
}

/** Rendered only for a confirmed administrator; the server rechecks every action. */
export function GovernanceModule({
  locale,
  state,
  controller,
}: GovernanceModuleProperties): ReactElement | null {
  if (state.access === null) return null;
  const m = governanceMessages(locale);
  return (
    <section
      className="dashboard-module governance-module"
      aria-labelledby="governance-heading"
      aria-busy={state.busy}
    >
      <h2 id="governance-heading">{m.heading}</h2>
      <p className="governance-note">{m.authority}</p>
      {state.busy && <p role="status">{m.busy}</p>}
      {state.problem !== null && <p role="alert">{m.problems[state.problem]}</p>}
      <nav className="governance-centers" aria-label={m.centers}>
        <h3>{m.centers}</h3>
        <button
          disabled={state.busy}
          onClick={() => {
            void controller.reload();
          }}
        >
          {m.reload}
        </button>
        <ul className="governance-list">
          {state.centers.map((center) => (
            <li key={center.centerId}>
              <span>{center.displayName}</span>
              <button
                aria-current={center.centerId === state.centerId ? "true" : undefined}
                onClick={() => {
                  void controller.selectCenter(center.centerId);
                }}
              >
                {m.select}
              </button>
            </li>
          ))}
        </ul>
        {state.pendingCenterId !== null && (
          <PendingSwitch
            m={m}
            confirm={(discard) => {
              void controller.confirmCenterSwitch(discard);
            }}
          />
        )}
      </nav>
      {state.centerId !== null && (
        <div className="governance-layout">
          <GovernanceClassesView m={m} state={state} controller={controller} />
          <GovernanceAccountsView m={m} state={state} controller={controller} />
        </div>
      )}
    </section>
  );
}
