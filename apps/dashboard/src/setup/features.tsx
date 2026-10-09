import type { SetupDetails } from "./fields.js";
import type { setupMessages } from "./messages.js";

export function SetupFeatures({
  value,
  change,
  m,
}: {
  value: SetupDetails;
  change: (value: SetupDetails) => void;
  m: ReturnType<typeof setupMessages>;
}) {
  const features = value.features ?? { map: false, reports: false, automaticEvaluation: false };
  return (
    <div className="setup-features">
      {(["map", "reports", "automaticEvaluation", "testingSkill"] as const).map((key) => {
        const label =
          key === "automaticEvaluation" ? "evaluation" : key === "testingSkill" ? "testing" : key;
        const checked = key === "testingSkill" ? value.testingSkill : features[key];
        return (
          <section key={key} className="feature-choice">
            <label className="setup-choice">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const selected = event.currentTarget.checked;
                  change(
                    key === "testingSkill"
                      ? { ...value, testingSkill: selected }
                      : { ...value, features: { ...features, [key]: selected } },
                  );
                }}
              />
              {m[label]}
            </label>
            <p>{m[`${label}Help`]}</p>
          </section>
        );
      })}
      <p className="server-help">{m.usageHelp}</p>
    </div>
  );
}
