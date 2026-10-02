import { AnalysisBudget } from "./budget-view.js";
import type { ReactNode } from "react";
import { mapSchema } from "./schemas.js";
import type { useInsightModel, InsightViewProps } from "./model.js";
import { UnconfiguredNotice } from "./unconfigured.js";
const states = ["red", "yellow", "green", "pending"] as const;
const icons = {
  red: "!",
  yellow: "?",
  green: "✓",
  pending: "…",
  error: "×",
  disabled: "–",
  disconnected: "○",
} as const;
/** Analysis times are shown as a short local time; the date is in the card's history. */
function analyzedTime(timestamp: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(timestamp),
  );
}
interface Props {
  model: ReturnType<typeof useInsightModel>;
  props: InsightViewProps & { classId: string };
  shared: ReactNode;
}
export function MapView({ model, props, shared }: Props) {
  const { m, setError, data } = model;

  const value = mapSchema.safeParse(data);
  return (
    <>
      {shared}
      <div className="map-header">
        <p className="map-note">{m.mapNote}</p>
        <ul className="map-legend">
          {states.map((state) => (
            <li key={state} data-attention={state}>
              <i aria-hidden="true" />
              {m[state]}
            </li>
          ))}
        </ul>
      </div>
      {value.success ? (
        <>
          <AnalysisBudget budget={value.data.budget} locale={props.locale} />
          {!value.data.enabled && <p>{m.disabled}</p>}
          {!value.data.configured && (
            <UnconfiguredNotice
              text={m.unconfigured}
              action={m.configureConnection}
              configure={props.configure}
            />
          )}
          {value.data.entries.length === 0 && <p>{m.empty}</p>}
          <div className="map-grid">
            {value.data.entries.map((entry) => (
              <article
                key={entry.runId}
                className="map-card"
                data-attention={entry.state}
                title={entry.reason}
              >
                <span className="map-icon" aria-hidden="true">
                  {icons[entry.state]}
                </span>
                <h3 className="map-name">{entry.student}</h3>
                <p className="map-project">{entry.project}</p>
                <strong className="map-state">{m[entry.state]}</strong>
                {entry.reason && <p className="map-reason">{entry.reason}</p>}
                <p className="map-meta">
                  {m[entry.confidence]}
                  {entry.analyzedAt !== null &&
                    ` · ${analyzedTime(entry.analyzedAt, props.locale)}`}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void props.navigate(entry.runId).then((ok) => {
                      if (!ok) setError(true);
                    })
                  }
                >
                  {m.session}
                </button>
              </article>
            ))}
          </div>
        </>
      ) : (
        <p>{m.loading}</p>
      )}
    </>
  );
}
