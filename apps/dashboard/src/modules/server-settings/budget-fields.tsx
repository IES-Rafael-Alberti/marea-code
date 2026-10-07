import type { UsagePolicy } from "@marea/protocol";
import type { serverSettingsMessages } from "./messages.js";
const unlimitedBudget: UsagePolicy = {
  version: "server:1",
  unlimited: true,
  costUnit: "units",
  inputCostUnitsPerToken: 0,
  outputCostUnitsPerToken: 0,
  maxRequests: 1000,
  maxTokens: 2000000,
  maxCostUnits: 10000000000,
  maxConcurrentRequests: 4,
  maxRequestDurationMs: 300000,
  maxInputTokens: 131072,
  maxOutputTokens: 32768,
  maxToolCalls: 1000,
};
export const emptyBudget = (): UsagePolicy => ({ ...unlimitedBudget });
const fields = {
  maxRequests: "requests",
  maxTokens: "tokens",
  maxInputTokens: "input",
  maxOutputTokens: "output",
  maxConcurrentRequests: "concurrent",
  maxRequestDurationMs: "duration",
  maxToolCalls: "tools",
  maxCostUnits: "cost",
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
      <label>
        <input
          type="checkbox"
          checked={value.unlimited === true}
          onChange={(event) => {
            change({ ...value, unlimited: event.currentTarget.checked });
          }}
        />
        {m.unlimited}
      </label>
      {value.unlimited !== true &&
        Object.entries(fields).map(([key, label]) => {
          const dollars = key === "maxCostUnits" && value.costUnit === "nanoUSD";
          return (
            <label key={key}>
              {dollars ? m.costUsd : m[label]}
              <input
                type="number"
                min={0}
                required
                step={dollars ? 0.001 : 1}
                value={value[key as keyof typeof fields] / (dollars ? 1000000000 : 1)}
                onChange={(event) => {
                  const next = event.currentTarget.valueAsNumber;
                  change({ ...value, [key]: dollars ? Math.round(next * 1000000000) : next });
                }}
              />
            </label>
          );
        })}
      {(["input", "output"] as const).map((direction) => {
        const key = direction === "input" ? "inputCostUnitsPerToken" : "outputCostUnitsPerToken";
        const factor = value.costUnit === "nanoUSD" ? 1000 : 1;
        return (
          <label key={direction}>
            {value.costUnit === "nanoUSD"
              ? m[direction === "input" ? "inputPriceUsd" : "outputPriceUsd"]
              : m[direction === "input" ? "inputPrice" : "outputPrice"]}
            <input
              type="number"
              min={0}
              step={1 / factor}
              required
              value={value[key] / factor}
              onChange={(event) => {
                change({ ...value, [key]: Math.round(event.currentTarget.valueAsNumber * factor) });
              }}
            />
          </label>
        );
      })}
      {value.costUnit !== "nanoUSD" && (
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
      )}
    </div>
  );
}
