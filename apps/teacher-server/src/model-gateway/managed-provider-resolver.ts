import { createInferenceProviderResolver } from "./provider-resolver.js";
import type {
  InferenceProvider,
  InferenceProviderCatalogEntry,
  InferenceProviderConfiguration,
} from "@marea/plugin-api";
import type { InferenceProviderResolver } from "../product-http/contracts.js";

/** New admissions use the current revision; admitted streams retain their provider instance. */
export function managedProviderResolver(
  catalog: readonly InferenceProviderCatalogEntry[],
  read: () => {
    revision: number;
    connections: Readonly<Record<string, Readonly<Record<string, string>>>>;
  } | null,
  legacy: Readonly<Record<string, InferenceProviderConfiguration>>,
): InferenceProviderResolver {
  const fallback = read() === null ? createInferenceProviderResolver(catalog, legacy) : undefined;
  let revision: number | undefined;
  const cache = new Map<string, InferenceProvider>();
  return {
    resolve(id) {
      const state = read();
      if (state === null) return fallback?.resolve(id);
      const next = state.revision;
      if (revision !== next) {
        cache.clear();
        revision = next;
      }
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const fields = state.connections[id];
      const config =
        fields === undefined
          ? undefined
          : {
              apiKey: fields.apiKey ?? "",
              ...(fields.endpoint === undefined ? {} : { endpoint: fields.endpoint }),
              settings: fields,
            };
      const entry = catalog.find((item) => item.manifest.id === id);
      if (config === undefined || entry === undefined) return undefined;
      const provider = entry.create(config);
      cache.set(id, provider);
      return provider;
    },
  };
}
