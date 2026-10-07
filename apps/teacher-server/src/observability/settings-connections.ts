import { randomUUID } from "node:crypto";
import {
  ProviderSettingsDescriptorSchema,
  type SessionTraceImplementation,
  type TelemetryExporterCatalogEntry,
} from "@marea/plugin-api";
import { ServerSettingsError, type ServerSettings } from "../server-settings/contracts.js";
import type { ObservabilityConfiguration } from "./configuration.js";

export function prepareTraceConnection(
  entry: SessionTraceImplementation,
  requested: Readonly<Record<string, string>>,
  previous: ObservabilityConfiguration | undefined,
) {
  const fields = ProviderSettingsDescriptorSchema.parse(entry.settings).fields;
  if (Object.keys(requested).some((key) => !fields.some((field) => field.key === key)))
    throw new ServerSettingsError(400);
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value =
      requested[field.key] ??
      (field.kind === "secret" ? previous?.values[field.key] : undefined) ??
      field.defaultValue;
    if (field.required && !value) throw new ServerSettingsError(400);
    if (value !== undefined) values[field.key] = value;
  }
  try {
    return { values, exporter: entry.create(values), fields };
  } catch {
    throw new ServerSettingsError(400);
  }
}
export function nextTraceConfiguration(
  pluginId: string,
  enabled: boolean,
  connection: ReturnType<typeof prepareTraceConnection>,
  previous: ObservabilityConfiguration | undefined,
): ObservabilityConfiguration {
  const same =
    previous?.pluginId === pluginId &&
    connection.fields
      .filter((f) => f.kind !== "secret")
      .every((f) => previous.values[f.key] === connection.values[f.key]);
  return {
    enabled,
    pluginId,
    values: connection.values,
    namespace: previous?.namespace ?? randomUUID(),
    epoch: same && previous.enabled === enabled ? previous.epoch : randomUUID(),
  };
}
export function projectTraceSettings(
  current: ServerSettings,
  catalog: readonly TelemetryExporterCatalogEntry[],
  status: object,
) {
  const settings = current.observability;
  return {
    revision: current.revision,
    enabled: settings?.enabled ?? false,
    pluginId: settings?.pluginId ?? null,
    status,
    plugins: catalog.flatMap((entry) => {
      if (entry.traces === undefined) return [];
      const descriptor = ProviderSettingsDescriptorSchema.parse(entry.traces.settings);
      const values = settings?.pluginId === entry.manifest.id ? settings.values : {};
      return [
        {
          id: entry.manifest.id,
          descriptor,
          values: Object.fromEntries(
            descriptor.fields
              .filter((f) => f.kind !== "secret")
              .flatMap((f) => (values[f.key] === undefined ? [] : [[f.key, values[f.key]]])),
          ),
          secrets: descriptor.fields
            .filter((f) => f.kind === "secret" && !!values[f.key])
            .map((f) => f.key),
        },
      ];
    }),
  };
}
