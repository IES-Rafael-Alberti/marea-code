import { AnalysisBudget } from "./budget-view.js";
import type { ReactNode } from "react";
import { mapSchema } from "./schemas.js";
import type { useInsightModel, InsightViewProps } from "./model.js";
import { UnconfiguredNotice } from "./unconfigured.js";
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
      <p>{m.mapNote}</p>
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
          {value.data.entries.map((entry) => (
            <article key={entry.runId} data-attention={entry.state}>
              <h3>
                {entry.student} · {entry.project}
              </h3>
              <strong>{m[entry.state]}</strong>
              <p>{entry.reason}</p>
              <p>
                {m[entry.confidence]} · {entry.analyzedAt}
              </p>
              <button
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
        </>
      ) : (
        <p>{m.loading}</p>
      )}
    </>
  );
}
