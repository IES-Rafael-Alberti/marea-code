import type { ProviderModel } from "@marea/plugin-api";
import type { UsagePolicy } from "@marea/protocol";
import type { ModelCatalogs } from "./provider-models.boundary.js";

export function ModelInput({
  id,
  label,
  value,
  providerId,
  catalogs,
  change,
}: {
  id: string;
  label: string;
  value: string;
  providerId: string;
  catalogs: ModelCatalogs;
  change: (model: string, pricing: ProviderModel["pricing"] | undefined) => void;
}) {
  const models = catalogs[providerId]?.models ?? [];
  return (
    <label className="server-field">
      {label}
      <input
        required
        list={id}
        value={value}
        onChange={(event) => {
          const model = event.currentTarget.value;
          change(model, models.find((item) => item.id === model)?.pricing);
        }}
      />
      <datalist id={id}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </datalist>
    </label>
  );
}

export function pricedBudget(
  budget: UsagePolicy,
  pricing: ProviderModel["pricing"] | undefined,
): UsagePolicy {
  return pricing ? { ...budget, ...pricing } : budget;
}
