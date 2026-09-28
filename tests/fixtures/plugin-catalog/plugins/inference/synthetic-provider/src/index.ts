import { defineInferenceProviderCatalogEntry } from "../../../../../../../packages/plugin-api/src/index.js";

export default defineInferenceProviderCatalogEntry({
  create() {
    return {
      // The provider contract requires an async stream even for this one-event fixture.
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream() {
        yield { finishReason: "stop", type: "completed" } as const;
      },
    };
  },
  manifest: {
    id: "org.marea.fixture-inference",
    displayNameKey: "plugins.fixture-inference.name",
    descriptionKey: "plugins.fixture-inference.description",
    kind: "inference-provider",
    apiVersion: "1.0",
    implementationVersion: "1.2.3",
    entrypoint: "./src/index.ts",
    configurationVersion: 1,
    requiredDependencies: [],
    optionalDependencies: [],
    conflicts: [],
    capabilities: ["streaming", "tool-calls"],
    runtimeTargets: ["teacher-server"],
    dataClassifications: ["student-content", "usage-metadata"],
  },
});
