import {
  ProviderSettingsDescriptorSchema,
  type InferenceProviderCatalogEntry,
} from "@marea/plugin-api";
import { ServerSettingsError, type ServerSettings } from "./contracts.js";
export function prepareConnections(
  catalog: readonly InferenceProviderCatalogEntry[],
  requested: ServerSettings["connections"],
  previous: ServerSettings["connections"],
) {
  return Object.fromEntries(
    Object.entries(requested).map(([id, fields]) => [
      id,
      prepareConnection(catalog, id, fields, previous),
    ]),
  );
}

export function prepareConnection(
  catalog: readonly InferenceProviderCatalogEntry[],
  id: string,
  fields: Record<string, string>,
  previous: ServerSettings["connections"],
): Record<string, string> {
  const entry = catalog.find((item) => item.manifest.id === id);
  if (entry?.settings === undefined) return retainUnavailableConnection(fields, previous[id]);
  const descriptor = ProviderSettingsDescriptorSchema.parse(entry.settings);
  const values: Record<string, string> = {};
  if (Object.keys(fields).some((key) => !descriptor.fields.some((field) => field.key === key)))
    throw new ServerSettingsError(400);
  for (const field of descriptor.fields) {
    const value =
      fields[field.key] ??
      (field.kind === "secret" ? previous[id]?.[field.key] : undefined) ??
      field.defaultValue;
    if (field.required && !value) throw new ServerSettingsError(400);
    if (value !== undefined) values[field.key] = value;
  }
  try {
    entry.create({
      apiKey: values.apiKey ?? "",
      ...(values.endpoint ? { endpoint: values.endpoint } : {}),
      settings: values,
    });
  } catch {
    throw new ServerSettingsError(400);
  }
  return values;
}

export function projectConnection(
  entry: InferenceProviderCatalogEntry,
  connections: ServerSettings["connections"],
) {
  const descriptor =
    entry.settings === undefined ? null : ProviderSettingsDescriptorSchema.parse(entry.settings);
  const values = connections[entry.manifest.id] ?? {};
  return {
    id: entry.manifest.id,
    ...(entry.listModels ? { supportsModels: true } : {}),
    descriptor,
    configured: connections[entry.manifest.id] !== undefined,
    values: Object.fromEntries(
      descriptor?.fields
        .filter((field) => field.kind !== "secret")
        .flatMap((field) =>
          values[field.key] === undefined ? [] : [[field.key, values[field.key]]],
        ) ?? [],
    ),
    secrets:
      descriptor?.fields
        .filter((field) => field.kind === "secret" && !!values[field.key])
        .map((field) => field.key) ?? [],
  };
}

function retainUnavailableConnection(
  fields: Readonly<Record<string, string>>,
  previous: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (previous === undefined || Object.keys(fields).length > 0) throw new ServerSettingsError(400);
  return { ...previous };
}
