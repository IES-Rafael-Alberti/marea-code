import { ServerSetupRequestSchema, type ServerSetupRequest } from "@marea/protocol";
import { inferenceProviderCatalog } from "@marea/plugin-runtime";
import type { InferenceProviderCatalogEntry } from "@marea/plugin-api";
import type { AuthenticatedIdentity } from "../../apps/teacher-server/src/identity/contracts.js";
import { ServerSettingsService } from "../../apps/teacher-server/src/server-settings/service.boundary.js";
import { providerModels } from "../../apps/teacher-server/src/server-settings/models.js";
import type { ServerSettings } from "../../apps/teacher-server/src/server-settings/contracts.js";
import { serverOrigin } from "./preview-channel.js";
import * as z from "zod";

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
    read: () => service.execute(setupTeacher, encode({ operation: "read" })),
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
          education: {},
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
