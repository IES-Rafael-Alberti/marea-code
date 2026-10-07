import type { TelemetryExporterCatalogEntry } from "@marea/plugin-api";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { ServerSettingsStore } from "../../server-settings/contracts.js";
import type { Clock } from "../../identity/contracts.js";
import { ObservabilityRuntime } from "../../observability/runtime.js";
import { ObservabilitySettingsService } from "../../observability/settings.boundary.js";
import { hasObservabilityStorage } from "../operations/retention/observability-retention.js";

export function composeObservability(
  database: SqliteApplicationDatabase,
  clock: Clock,
  store: ServerSettingsStore | undefined,
  config:
    | { readonly catalog: readonly TelemetryExporterCatalogEntry[]; readonly release: string }
    | undefined,
) {
  if (store === undefined || config === undefined || !hasObservabilityStorage(database))
    return undefined;
  return new ObservabilityRuntime(database, store, config.catalog, clock, config.release, () => {
    const settings = store.read();
    return [
      ...Object.values(settings?.connections ?? {}).flatMap((connection) =>
        Object.values(connection),
      ),
      ...Object.values(settings?.observability?.values ?? {}),
    ];
  });
}
export function observabilityEndpoint(runtime: ObservabilityRuntime | undefined) {
  return runtime === undefined
    ? {}
    : {
        observability: new ObservabilitySettingsService(
          runtime.store,
          runtime.catalog,
          runtime,
          runtime.clock,
          runtime.release,
        ),
      };
}
