import type { TeacherHealthResponse } from "@marea/protocol";
import type { DashboardLocale } from "../../messages.js";
import type { HealthState } from "./health-controller.js";
import { healthMessages } from "./health-messages.js";
import "../usage-health.css";

const COMPONENTS = ["storage", "usageLedger", "inference", "telemetryDelivery"] as const;

/** Unknown and stale are preserved; configuration is never presented as delivery evidence. */
export function HealthView({
  locale,
  state,
  refresh,
}: {
  readonly locale: DashboardLocale;
  readonly state: HealthState;
  readonly refresh: () => void;
}) {
  const m = healthMessages(locale);
  const time = (value: string) => (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(
        new Date(value),
      )}
    </time>
  );
  const observation = (response: TeacherHealthResponse, component: (typeof COMPONENTS)[number]) => {
    const value = response[component];
    return (
      <div key={component}>
        <dt>{m[component]}</dt>
        <dd>{m[value.status]}</dd>
        <dd>
          {m.observed}: {value.observedAt === null ? m.notObserved : time(value.observedAt)}
        </dd>
        {component === "inference" && <dd>{m.inferenceNote}</dd>}
        {component === "telemetryDelivery" && <dd>{m.telemetryNote}</dd>}
      </div>
    );
  };
  return (
    <section className="class-projection" aria-label={m.title}>
      <h2>{m.title}</h2>
      <p>{m.meaning}</p>
      <div role="status" aria-live="polite" aria-atomic="true">
        {state.status === "ready" ? (
          <p>
            {m.checked}: {time(state.response.generatedAt)}
          </p>
        ) : (
          <p>{m[state.status]}</p>
        )}
      </div>
      {state.status === "ready" && (
        <>
          <p>{m.staleAfter.replace("{minutes}", String(state.response.freshnessMs / 60_000))}</p>
          <dl>{COMPONENTS.map((component) => observation(state.response, component))}</dl>
        </>
      )}
      <button
        type="button"
        disabled={state.status === "empty" || state.status === "loading"}
        onClick={refresh}
      >
        {m.refresh}
      </button>
    </section>
  );
}
