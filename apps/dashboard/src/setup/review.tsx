import type { SetupDetails } from "./fields.js";
import type { setupMessages } from "./messages.js";

export function SetupReview({
  value,
  model,
  m,
  edit,
}: {
  value: SetupDetails;
  model: string;
  m: ReturnType<typeof setupMessages>;
  edit: (step: number) => void;
}) {
  const features = [
    value.features?.map && m.map,
    value.features?.reports && m.reports,
    value.features?.automaticEvaluation && m.evaluation,
    value.testingSkill && m.testing,
  ].filter(Boolean);
  const rows = [
    { label: m.school, text: `${value.center} · ${value.classroom}`, step: 0 },
    { label: m.account, text: `${value.teacher} (${value.login})`, step: 0 },
    { label: m.steps[1], text: model, step: 1 },
    {
      label: m.network,
      text: value.access === "https" ? value.publicOrigin : m[value.access],
      step: 2,
    },
    { label: m.steps[3], text: features.length ? features.join(" · ") : m.none, step: 3 },
  ];
  return (
    <>
      <dl className="setup-review">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.text}</dd>
            <dd>
              <button
                type="button"
                aria-label={`${m.change}: ${row.label}`}
                onClick={() => {
                  edit(row.step);
                }}
              >
                {m.change}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <p>{m.review}</p>
    </>
  );
}
