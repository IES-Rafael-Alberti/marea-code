import { ProviderModelListSchema, type InferenceProviderCatalogEntry } from "@marea/plugin-api";
import type { LearningProgress } from "../../educational-insights/progress.js";
import type { NotesModels } from "../../educational-insights/service.js";
import { ConfigurationSnapshotSource } from "../../teaching/configuration/configuration-snapshot-source.js";
import type { ServerSettingsStore } from "../../server-settings/contracts.js";
import { usesCommonRoute } from "../../server-settings/operator.js";
import type { RunSnapshotCapture } from "../../sessions/contracts.js";
import type { TeachingConfigurationRepository } from "../../teaching/configuration/contracts.js";

interface ServerSettingsDependency {
  readonly store: ServerSettingsStore;
  readonly catalog: readonly InferenceProviderCatalogEntry[];
}

/** A new session uses the server's common route when it replaces the class routes. */
function withSessionRoute(settings: ServerSettingsDependency | undefined) {
  return (capture: RunSnapshotCapture): RunSnapshotCapture => {
    const current = settings?.store.read();
    return current && usesCommonRoute(current)
      ? { ...capture, providerRoute: current.route }
      : capture;
  };
}

/** New sessions capture the class configuration, adapted to reviewed progress when enabled. */
export function sessionSnapshots(
  configurations: TeachingConfigurationRepository,
  settings: ServerSettingsDependency | undefined,
  progress: Pick<LearningProgress, "capture" | "prepare"> | undefined,
): ConfigurationSnapshotSource {
  const route = withSessionRoute(settings);
  return progress === undefined
    ? new ConfigurationSnapshotSource(configurations, route)
    : new ConfigurationSnapshotSource(
        configurations,
        (capture, identity) => progress.capture(route(capture), identity),
        (capture, identity) => progress.prepare(route(capture), identity),
      );
}

/**
 * Where learning-notes summaries find their model: the class route new sessions would use, and
 * the provider-agnostic model catalog for its context window. Unknown answers are undefined.
 */
export function notesModels(
  configurations: Pick<TeachingConfigurationRepository, "loadForTeacher">,
  settings: ServerSettingsDependency | undefined,
): NotesModels {
  return {
    classRoute: (teacherId, classId) => {
      const current = settings?.store.read();
      return current && usesCommonRoute(current)
        ? current.route
        : configurations.loadForTeacher(teacherId, classId)?.providerRoute;
    },
    contextWindow: async (providerId, model, signal) => {
      const values = settings?.store.read()?.connections[providerId];
      const entry = settings?.catalog.find((item) => item.manifest.id === providerId);
      if (values === undefined || entry?.listModels === undefined) return undefined;
      const models = ProviderModelListSchema.parse(
        await entry.listModels(
          {
            apiKey: values.apiKey ?? "",
            ...(values.endpoint ? { endpoint: values.endpoint } : {}),
            settings: values,
          },
          signal,
        ),
      );
      return models.find((item) => item.id === model)?.contextWindowTokens;
    },
  };
}
