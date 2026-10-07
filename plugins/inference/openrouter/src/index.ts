import {
  defineInferenceProviderCatalogEntry,
  type InferenceProviderCatalogEntry,
} from "@marea/plugin-api";

import { parseOpenRouterConfiguration } from "./configuration.js";
import { openRouterHttp } from "./openrouter-http.boundary.js";
import { createOpenRouterProviderWith } from "./provider.js";
import { listOpenRouterModels } from "./models.boundary.js";

const openRouterProviderPlugin: InferenceProviderCatalogEntry = defineInferenceProviderCatalogEntry(
  {
    listModels: listOpenRouterModels,
    settings: {
      version: 1,
      name: { es: "OpenRouter", en: "OpenRouter", eu: "OpenRouter" },
      fields: [
        {
          key: "apiKey",
          kind: "secret",
          required: true,
          label: { es: "Clave API", en: "API key", eu: "API gakoa" },
        },
        {
          key: "endpoint",
          kind: "url",
          required: false,
          defaultValue: "https://openrouter.ai/api/v1/chat/completions",
          label: {
            es: "Dirección del servicio",
            en: "Service address",
            eu: "Zerbitzuaren helbidea",
          },
        },
      ],
    },
    create(configuration) {
      return createOpenRouterProviderWith(
        parseOpenRouterConfiguration(configuration),
        openRouterHttp,
      );
    },
    manifest: {
      apiVersion: "1.0",
      capabilities: ["streaming", "tool-calls"],
      configurationVersion: 1,
      conflicts: [],
      dataClassifications: ["student-content", "usage-metadata"],
      descriptionKey: "plugins.openrouter.description",
      displayNameKey: "plugins.openrouter.name",
      entrypoint: "./src/index.ts",
      id: "org.marea.openrouter",
      implementationVersion: "0.1.0",
      kind: "inference-provider",
      optionalDependencies: [],
      requiredDependencies: [],
      runtimeTargets: ["teacher-server"],
    },
  },
);

export default openRouterProviderPlugin;
