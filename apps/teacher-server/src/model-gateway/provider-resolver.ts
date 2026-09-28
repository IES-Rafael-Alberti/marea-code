import type {
  InferenceProviderCatalogEntry,
  InferenceProviderConfiguration,
} from "@marea/plugin-api";

import type { InferenceProviderResolver } from "../product-http/contracts.js";

export function createInferenceProviderResolver(
  catalog: readonly InferenceProviderCatalogEntry[],
  configurations: Readonly<Record<string, InferenceProviderConfiguration>>,
): InferenceProviderResolver {
  const entries = new Map<string, InferenceProviderCatalogEntry>();
  for (const entry of catalog) {
    if (entries.has(entry.manifest.id)) {
      throw new Error("The inference provider catalog contains a duplicate identifier.");
    }
    entries.set(entry.manifest.id, entry);
  }
  for (const configuredId of Object.keys(configurations)) {
    if (!entries.has(configuredId)) {
      throw new Error("The inference provider configuration references an unavailable plugin.");
    }
  }
  const providers = new Map(
    catalog.flatMap((entry) => {
      const configuration = configurations[entry.manifest.id];
      return configuration === undefined ? [] : [[entry.manifest.id, entry.create(configuration)]];
    }),
  );
  return Object.freeze({ resolve: (providerId: string) => providers.get(providerId) });
}
