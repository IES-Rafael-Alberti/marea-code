import type { UsagePolicy } from "@marea/protocol";
import type { serverSettingsMessages } from "./messages.js";
export const emptyBudget = (): UsagePolicy => ({
  version: "server:1",
  costUnit: "units",
  inputCostUnitsPerToken: 0,
  outputCostUnitsPerToken: 0,
  maxRequests: 0,
  maxTokens: 0,
  maxCostUnits: 0,
  maxConcurrentRequests: 1,
  maxRequestDurationMs: 30000,
  maxInputTokens: 1,
  maxOutputTokens: 1,
  maxToolCalls: 0,
});
const fields = {
  maxRequests: "requests",
  maxTokens: "tokens",
  maxInputTokens: "input",
  maxOutputTokens: "output",
  maxConcurrentRequests: "concurrent",
  maxRequestDurationMs: "duration",
  maxToolCalls: "tools",
  maxCostUnits: "cost",
  inputCostUnitsPerToken: "inputPrice",
  outputCostUnitsPerToken: "outputPrice",
} as const;
export function BudgetFields({
  value,
  change,
  m,
}: {
  value: UsagePolicy;
  change: (value: UsagePolicy) => void;
  m: ReturnType<typeof serverSettingsMessages>;
}) {
  return (
    <div className="server-settings-fields">
      {Object.entries(fields).map(([key, label]) => (
        <label key={key}>
          {m[label]}
          <input
            type="number"
            min={0}
            required
            value={value[key as keyof typeof fields]}
            onChange={(event) => {
              change({ ...value, [key]: event.currentTarget.valueAsNumber });
            }}
          />
        </label>
      ))}
      <label>
        {m.unit}
        <input
          required
          value={value.costUnit}
          onChange={(event) => {
            change({ ...value, costUnit: event.currentTarget.value });
          }}
        />
      </label>
    </div>
  );
}
