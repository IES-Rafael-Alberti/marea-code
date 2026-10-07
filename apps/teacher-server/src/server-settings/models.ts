import {
  InferenceProviderError,
  ProviderModelListSchema,
  type InferenceProviderCatalogEntry,
} from "@marea/plugin-api";
import { prepareConnection } from "./connections.js";
import { ServerSettingsError, type ServerSettings } from "./contracts.js";

/** Check draft credentials without persisting them or returning provider account details. */
export async function providerModels(
  catalog: readonly InferenceProviderCatalogEntry[],
  current: ServerSettings,
  providerId: string,
  requested: Record<string, string>,
  signal: AbortSignal,
) {
  const entry = catalog.find((item) => item.manifest.id === providerId);
  if (!entry?.listModels) throw new ServerSettingsError(422);
  const values = prepareConnection(catalog, providerId, requested, current.connections);
  try {
    const models = await entry.listModels(
      {
        apiKey: values.apiKey ?? "",
        ...(values.endpoint ? { endpoint: values.endpoint } : {}),
        settings: values,
      },
      signal,
    );
    return { providerId, models: ProviderModelListSchema.parse(models) };
  } catch (error) {
    throw new ServerSettingsError(
      error instanceof InferenceProviderError && error.code === "authentication-failed" ? 400 : 503,
    );
  }
}
