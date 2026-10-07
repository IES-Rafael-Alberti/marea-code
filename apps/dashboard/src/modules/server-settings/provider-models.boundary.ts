import { ProviderModelListSchema, type ProviderModel } from "@marea/plugin-api";
import { useEffect, useState } from "react";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import type { SettingsResponse } from "./client.boundary.js";

export interface ModelCatalog {
  status: "loading" | "ready" | "invalid" | "unavailable";
  models: readonly ProviderModel[];
}
export type ModelCatalogs = Readonly<Record<string, ModelCatalog | undefined>>;

export async function requestModels(
  fetchRequest: DashboardFetch,
  providerId: string,
  values: Record<string, string>,
  signal: AbortSignal,
): Promise<ModelCatalog> {
  const response = await fetchRequest("/api/v1/dashboard/server-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "models", providerId, values }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status === 400 ? "invalid" : "unavailable", models: [] };
  }
  const text = await response.text();
  if (text.length > 2097152) throw new Error("oversized-model-catalog");
  const result = JSON.parse(text) as { providerId?: unknown; models?: unknown };
  if (result.providerId !== providerId) throw new Error("unexpected-provider");
  return { status: "ready", models: ProviderModelListSchema.parse(result.models) };
}

/** Debounce credential edits; abort obsolete requests and never overwrite a newer result. */
export function useProviderModels(
  fetchRequest: DashboardFetch,
  state: SettingsResponse | null,
  connections: Record<string, Record<string, string>>,
) {
  const [catalogs, setCatalogs] = useState<ModelCatalogs>({});
  const [attempt, setAttempt] = useState(0);
  const drafts =
    state?.administrator === true
      ? state.providers.flatMap((provider) => {
          const values = connections[provider.id];
          if (!provider.supportsModels || !values || !provider.descriptor) return [];
          const ready = provider.descriptor.fields.every(
            (field) =>
              !field.required ||
              !!(values[field.key] ?? field.defaultValue) ||
              provider.secrets.includes(field.key),
          );
          return ready ? [{ providerId: provider.id, values }] : [];
        })
      : [];
  const encoded = JSON.stringify(drafts);
  useEffect(() => {
    const requested = JSON.parse(encoded) as typeof drafts;
    const controller = new AbortController();
    setCatalogs(
      Object.fromEntries(
        requested.map(({ providerId }) => [providerId, { status: "loading", models: [] }]),
      ),
    );
    const timer = setTimeout(() => {
      for (const { providerId, values } of requested) {
        void requestModels(fetchRequest, providerId, values, controller.signal)
          .catch((): ModelCatalog => ({ status: "unavailable", models: [] }))
          .then((result) => {
            if (!controller.signal.aborted)
              setCatalogs((previous) => ({ ...previous, [providerId]: result }));
          });
      }
    }, 800);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchRequest, encoded, attempt]);
  return {
    catalogs,
    refresh: () => {
      setAttempt((previous) => previous + 1);
    },
  };
}
