import { localHttpHosts } from "../../apps/teacher-server/src/platform/teacher-host/http-access.boundary.js";
import { ServerSetupRequestSchema, type ServerSetupRequest } from "@marea/protocol";
import { inferenceProviderCatalog, identityProviderCatalog } from "@marea/plugin-runtime";
import {
  parseIdentityProviderEntry,
  type IdentityProviderCatalogEntry,
  type InferenceProviderCatalogEntry,
} from "@marea/plugin-api";
import type { AuthenticatedIdentity } from "../../apps/teacher-server/src/identity/contracts.js";
import { ServerSettingsService } from "../../apps/teacher-server/src/server-settings/service.boundary.js";
import { providerModels } from "../../apps/teacher-server/src/server-settings/models.js";
import type { ServerSettings } from "../../apps/teacher-server/src/server-settings/contracts.js";
import { serverOrigin } from "./preview-channel.js";
import * as z from "zod";
import {
  providerSettingsValues,
  systemIdentityRuntime,
} from "../../apps/teacher-server/src/platform/teacher-host/identity-provider-composition.js";

export const setupTeacher: AuthenticatedIdentity = {
  role: "teacher",
  userId: "user:teacher",
  classId: null,
  displayName: "Teacher",
};

export function emptySetupSettings(): ServerSettings {
  return {
    version: 1,
    revision: 0,
    administrators: [setupTeacher.userId],
    connections: {},
    route: null,
    legacyRoutes: [],
    education: {},
    useCommonRoute: false,
  };
}

/** Reuses the same descriptors, credentials validation and model lookup as the dashboard. */
export function onboardingSettings(
  catalog: readonly InferenceProviderCatalogEntry[] = inferenceProviderCatalog,
  identities: readonly IdentityProviderCatalogEntry[] = identityProviderCatalog,
) {
  let settings = emptySetupSettings();
  const service = new ServerSettingsService(
    {
      read: () => settings,
      write: (next) => {
        settings = next;
      },
    },
    catalog,
  );
  const encode = (value: object) => new TextEncoder().encode(JSON.stringify(value));
  return {
    read: async () => ({
      addresses: localHttpHosts().filter(
        (host) => host !== "localhost" && !host.startsWith("127."),
      ),
      settings: await service.execute(setupTeacher, encode({ operation: "read" })),
      identityProviders: identities.map((entry) => ({
        id: entry.manifest.id,
        descriptor: parseIdentityProviderEntry(entry).settings,
      })),
    }),
    async models(input: unknown, signal: AbortSignal) {
      const query = z
        .object({
          operation: z.literal("models"),
          providerId: z.string().max(128),
          values: z.record(z.string().max(64), z.string().max(2048)),
        })
        .strict()
        .parse(input);
      return providerModels(catalog, settings, query.providerId, query.values, signal);
    },
    async validate(
      input: unknown,
      signal: AbortSignal,
    ): Promise<{ request: ServerSetupRequest; settings: ServerSettings; origin: string }> {
      const request = ServerSetupRequestSchema.parse(input);
      for (const [id, values] of Object.entries(request.identityProviders ?? {})) {
        const installed = identities.find((entry) => entry.manifest.id === id);
        if (!installed) throw new Error("identity-provider-unavailable");
        const entry = parseIdentityProviderEntry(installed);
        entry.create(providerSettingsValues(entry.settings, values), systemIdentityRuntime);
      }
      const origin =
        request.access === "https"
          ? serverOrigin(request.publicOrigin)
          : `http://127.0.0.1:${String(request.port)}`;
      if (request.access === "https" && !origin.startsWith("https://"))
        throw new Error("invalid-origin");
      await service.execute(
        setupTeacher,
        encode({
          operation: "save",
          expectedRevision: settings.revision,
          connections: request.connections,
          route: request.route,
          education: setupTaskRoutes(request),
          useCommonRoute: true,
        }),
      );
      if (
        catalog.some(
          (provider) =>
            provider.manifest.id === request.route.providerId && provider.listModels !== undefined,
        )
      )
        await providerModels(catalog, settings, request.route.providerId, {}, signal);
      return { request, settings, origin };
    },
  };
}

/** Optional tasks start with the same verified connection, model and unlimited budget. */
function setupTaskRoutes(request: ServerSetupRequest): ServerSettings["education"] {
  const budget = request.route.budget;
  const task = {
    providerId: request.route.providerId,
    model: request.route.model,
    inputTokenCeiling: budget.inputTokenCeiling,
    budget: budget.evaluation,
  };
  return {
    ...(request.features?.map ? { map: task } : {}),
    ...(request.features?.reports ? { reports: task } : {}),
  };
}
