import {
  defineInferenceProviderCatalogEntry,
  type InferenceProviderCatalogEntry,
} from "@marea/plugin-api";

import { parseOpenRouterConfiguration } from "./configuration.js";
import { openRouterHttp } from "./openrouter-http.boundary.js";
import { createOpenRouterProviderWith } from "./provider.js";

const openRouterProviderPlugin: InferenceProviderCatalogEntry = defineInferenceProviderCatalogEntry(
  {
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
