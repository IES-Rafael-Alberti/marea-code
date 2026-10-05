import {
  parseIdentityProviderEntry,
  type IdentityProviderCatalogEntry,
  type IdentityProviderRuntime,
  type ProviderSettingsDescriptor,
} from "@marea/plugin-api";
import { z } from "zod";

import type { ConfiguredIdentityProvider } from "../../external-identity/contracts.js";
import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";

const MAX_SETTINGS_BYTES = 65_536;

/** Network and time as plugins see them in a running host. */
export const systemIdentityRuntime: IdentityProviderRuntime = Object.freeze({
  fetch: (request: Request) => fetch(request),
  now: () => Date.now(),
});

/** A private, bounded UTF-8 JSON settings file named by the host configuration. */
export function readIdentityProviderSettings(path: string): unknown {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(readBoundedBytes(path, MAX_SETTINGS_BYTES)),
  );
}

const SettingsFileSchema = z.record(z.string(), z.string().max(16_384)).readonly();

export interface IdentityProviderConfiguration {
  readonly pluginId: string;
  readonly settingsPath: string;
}

/** Values for exactly the declared fields, with declared defaults and required values present. */
export function providerSettingsValues(
  descriptor: ProviderSettingsDescriptor,
  input: unknown,
): Readonly<Record<string, string>> {
  const values = SettingsFileSchema.parse(input);
  if (Object.keys(values).some((key) => !descriptor.fields.some((field) => field.key === key)))
    throw new Error("The identity provider settings contain an undeclared field.");
  const resolved: Record<string, string> = {};
  for (const field of descriptor.fields) {
    const value = values[field.key] ?? field.defaultValue ?? "";
    if (field.required && value === "")
      throw new Error("The identity provider settings miss a required field.");
    if (field.kind === "url" && value !== "" && !URL.canParse(value))
      throw new Error("The identity provider settings contain an invalid address.");
    if (value !== "") resolved[field.key] = value;
  }
  return Object.freeze(resolved);
}

/**
 * Builds the configured providers that are still installed. A configured plugin whose folder was
 * removed is skipped, so its sign-in option disappears without blocking the host.
 */
export function configureIdentityProviders(
  catalog: readonly IdentityProviderCatalogEntry[],
  configured: readonly IdentityProviderConfiguration[] | undefined,
  readSettings: (path: string) => unknown,
  runtime: IdentityProviderRuntime,
): readonly ConfiguredIdentityProvider[] {
  if (configured === undefined) return [];
  return configured.flatMap(({ pluginId, settingsPath }) => {
    const installed = catalog.find((entry) => entry.manifest.id === pluginId);
    if (installed === undefined) return [];
    const entry = parseIdentityProviderEntry(installed);
    return [
      {
        id: pluginId,
        descriptor: entry.descriptor,
        provider: entry.create(
          providerSettingsValues(entry.settings, readSettings(settingsPath)),
          runtime,
        ),
      },
    ];
  });
}
