import {
  defineInferenceProviderCatalogEntry,
  type InferenceProvider,
  type InferenceProviderCatalogEntry,
} from "@marea/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { createInferenceProviderResolver } from "./provider-resolver.js";

const provider: InferenceProvider = {
  async *stream() {
    await Promise.resolve();
    yield { finishReason: "stop", type: "completed" };
  },
};

function entry(id: string): InferenceProviderCatalogEntry {
  return defineInferenceProviderCatalogEntry({
    create: vi.fn(() => provider),
    manifest: {
      apiVersion: "1.0",
      capabilities: ["streaming"],
      configurationVersion: 1,
      conflicts: [],
      dataClassifications: ["student-content"],
      descriptionKey: `plugins.${id}.description`,
      displayNameKey: `plugins.${id}.name`,
      entrypoint: "./src/index.ts",
      id,
      implementationVersion: "1.0.0",
      kind: "inference-provider",
      optionalDependencies: [],
      requiredDependencies: [],
      runtimeTargets: ["teacher-server"],
    },
  });
}

describe("inference provider resolver", () => {
  it("constructs only configured providers and resolves them by manifest identifier", () => {
    const configured = entry("org.marea.configured");
    const disabled = entry("org.marea.disabled");
    const resolver = createInferenceProviderResolver([configured, disabled], {
      "org.marea.configured": { apiKey: "server-secret-value" },
    });

    expect(resolver.resolve("org.marea.configured")).toBe(provider);
    expect(resolver.resolve("org.marea.disabled")).toBeUndefined();
    expect(configured.create).toHaveBeenCalledWith({ apiKey: "server-secret-value" });
    expect(disabled.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate catalog identifiers and unavailable configurations", () => {
    const configured = entry("org.marea.configured");

    expect(() => createInferenceProviderResolver([configured, configured], {})).toThrow(
      "duplicate identifier",
    );
    expect(() =>
      createInferenceProviderResolver([configured], {
        "org.marea.missing": { apiKey: "server-secret-value" },
      }),
    ).toThrow("unavailable plugin");
  });
});
