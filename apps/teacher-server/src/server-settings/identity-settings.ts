import {
  parseIdentityProviderEntry,
  type IdentityProviderCatalogEntry,
  type IdentityProviderRuntime,
} from "@marea/plugin-api";
import { ServerSettingsError, type ServerSettings, type ServerSettingsStore } from "./contracts.js";

type Connections = NonNullable<ServerSettings["identityConnections"]>;
export interface IdentitySettingsOptions {
  readonly catalog: readonly IdentityProviderCatalogEntry[];
  readonly active: Connections;
  readonly runtime: IdentityProviderRuntime;
}

/** Private settings and public readiness have separate projections. Applying credentials requires a host restart. */
export class IdentitySettings {
  constructor(
    readonly store: ServerSettingsStore,
    readonly options: IdentitySettingsOptions,
  ) {}

  read(current: ServerSettings) {
    const connections = current.identityConnections ?? this.options.active;
    return {
      revision: current.revision,
      restart: JSON.stringify(connections) !== JSON.stringify(this.options.active),
      providers: this.options.catalog.map((raw) => {
        const entry = parseIdentityProviderEntry(raw);
        const values = connections[entry.manifest.id];
        return {
          id: entry.manifest.id,
          descriptor: entry.settings,
          configured: values !== undefined,
          values: Object.fromEntries(
            entry.settings.fields.flatMap((field) => {
              const value = values?.[field.key];
              return field.kind === "secret" || value === undefined ? [] : [[field.key, value]];
            }),
          ),
          secrets: entry.settings.fields
            .filter((f) => f.kind === "secret" && Boolean(values?.[f.key]))
            .map((f) => f.key),
        };
      }),
    };
  }

  status() {
    return {
      providers: this.options.catalog.map((raw) => {
        const entry = parseIdentityProviderEntry(raw);
        const values = this.options.active[entry.manifest.id];
        const provider =
          values === undefined ? undefined : entry.create(values, this.options.runtime);
        return {
          id: entry.manifest.id,
          guides: entry.settings.guides ?? [],
          kinds: entry.descriptor.ruleKinds.map((rule) => ({
            kind: rule.kind,
            ready: provider !== undefined && (provider.supportsRule?.(rule.kind) ?? true),
          })),
        };
      }),
    };
  }

  save(current: ServerSettings, expectedRevision: number, requested: Connections) {
    if (current.revision !== expectedRevision) throw new ServerSettingsError(409);
    const previous = current.identityConnections ?? this.options.active;
    const connections = Object.fromEntries(
      Object.entries(requested).map(([id, fields]) => {
        const installed = this.options.catalog.find((entry) => entry.manifest.id === id);
        if (!installed) throw new ServerSettingsError(400);
        const entry = parseIdentityProviderEntry(installed);
        if (Object.keys(fields).some((key) => !entry.settings.fields.some((f) => f.key === key)))
          throw new ServerSettingsError(400);
        const values: Record<string, string> = {};
        for (const field of entry.settings.fields) {
          const value =
            fields[field.key] ??
            (field.kind === "secret" ? previous[id]?.[field.key] : undefined) ??
            field.defaultValue;
          if (field.required && !value) throw new ServerSettingsError(400);
          if (field.kind === "url" && value && !URL.canParse(value))
            throw new ServerSettingsError(400);
          if (value) values[field.key] = value;
        }
        try {
          entry.create(values, this.options.runtime);
        } catch {
          throw new ServerSettingsError(400);
        }
        return [id, values];
      }),
    );
    const next = {
      ...current,
      revision: current.revision + 1,
      identityConnections: {
        ...Object.fromEntries(
          Object.entries(previous).filter(
            ([id]) => !this.options.catalog.some((entry) => entry.manifest.id === id),
          ),
        ),
        ...connections,
      },
    };
    this.store.write(next, current.revision);
    return this.read(next);
  }
}
