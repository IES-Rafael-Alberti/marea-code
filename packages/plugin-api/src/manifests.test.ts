import { moduleFixture, fixtureThemeTokens } from "./dashboard.fixture.js";
import * as z from "zod";
import { describe, expect, it } from "vitest";

import {
  createDashboardModuleManifestSchema,
  defineDashboardModuleCatalogEntry,
  defineSettinglessDashboardModule,
} from "./dashboard-module.js";
import {
  createDashboardThemeManifestSchema,
  defineDashboardThemeCatalogEntry,
} from "./dashboard-theme.js";
import {
  createInferenceProviderManifestSchema,
  defineInferenceProviderCatalogEntry,
  InferenceProviderError,
} from "./inference-provider.js";
import {
  createCommonManifestShape,
  createImplementationVersionSchema,
  createPluginEntrypointSchema,
  createPluginIdSchema,
  createPluginRelationshipsSchema,
  createTranslationKeySchema,
  hasSafeRelationships,
  safeRelationshipMessage,
} from "./manifest-fields.js";
import {
  createTelemetryExporterManifestSchema,
  defineTelemetryExporterCatalogEntry,
} from "./telemetry-exporter.js";

const commonFields = {
  id: "org.marea.example",
  displayNameKey: "plugins.example.name",
  descriptionKey: "plugins.example.description",
  implementationVersion: "1.2.3",
  entrypoint: "./src/index.ts",
  configurationVersion: 1,
} as const;

const inferenceManifest = {
  ...commonFields,
  kind: "inference-provider",
  apiVersion: "1.0",
  capabilities: ["streaming", "tool-calls"],
  runtimeTargets: ["teacher-server"],
  dataClassifications: ["student-content"],
} as const;

const telemetryManifest = {
  ...commonFields,
  kind: "telemetry-exporter",
  apiVersion: "1.0",
  capabilities: ["trace-export"],
  runtimeTargets: ["teacher-server"],
  acceptedDataClassifications: ["operational"],
  destination: "external",
} as const;

const dashboardModuleManifest = moduleFixture.manifest;

const dashboardThemeManifest = {
  ...commonFields,
  kind: "dashboard-theme",
  apiVersion: "2.0",
  colorScheme: "light",
  highContrast: false,
  capabilities: ["light-color-scheme"],
  runtimeTargets: ["dashboard-browser"],
} as const;

describe("shared plugin manifest fields", () => {
  it("accepts the portable boundaries", () => {
    const maximumId = `a.${"b".repeat(158)}`;
    const maximumEntrypoint = `./${"a".repeat(235)}.ts`;
    const maximumVersion = `1.0.0+${"a".repeat(58)}`;

    expect(createPluginIdSchema().parse("a.b")).toBe("a.b");
    expect(createPluginIdSchema().parse(maximumId)).toBe(maximumId);
    expect(createTranslationKeySchema().parse("a.b")).toBe("a.b");
    expect(createTranslationKeySchema().parse(maximumId)).toBe(maximumId);
    expect(createPluginEntrypointSchema().parse("./index.ts")).toBe("./index.ts");
    expect(createPluginEntrypointSchema().parse(maximumEntrypoint)).toBe(maximumEntrypoint);
    expect(createImplementationVersionSchema().parse("0.0.0-alpha.1+build.2")).toContain("alpha");
    expect(createImplementationVersionSchema().parse(maximumVersion)).toBe(maximumVersion);
  });

  it.each(["", "ab", "A.b", "a", "a..b", "a.b!", `a.${"b".repeat(159)}`])(
    "rejects unsafe plugin ID %s",
    (id) => {
      expect(() => createPluginIdSchema().parse(id)).toThrow();
    },
  );

  it("reports the plugin ID portability rule", () => {
    expect(() => createPluginIdSchema().parse("!a.b")).toThrow(
      "Use a lowercase reverse-domain or Marea-owned plugin ID.",
    );
  });

  it.each(["", "ab", "A.b", "a b.c", "a.b!", `a.${"b".repeat(159)}`])(
    "rejects unsafe translation key %s",
    (key) => {
      expect(() => createTranslationKeySchema().parse(key)).toThrow();
    },
  );

  it("reports the translation key portability rule", () => {
    expect(() => createTranslationKeySchema().parse("!a.b")).toThrow(
      "Use a portable translation key.",
    );
  });

  it.each([
    "index.ts",
    "/src/index.ts",
    "./../index.ts",
    "./src/../../index.ts",
    ".\\src\\index.ts",
    "./src/index.js",
    "./src/index.ts!",
    "./Src/index.ts",
    `./${"a".repeat(236)}.ts`,
  ])("rejects unsafe entrypoint %s", (entrypoint) => {
    expect(() => createPluginEntrypointSchema().parse(entrypoint)).toThrow();
  });

  it("reports the safe entrypoint rule", () => {
    expect(() => createPluginEntrypointSchema().parse("index.ts")).toThrow(
      "Use a relative TypeScript entrypoint without parent traversal.",
    );
  });

  it.each([
    "v1.2.3",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2",
    "1.2.3-",
    "1.2.3-01",
    "1.2.3-alpha.01",
    "1.2.3+",
    "1.2.3+build..2",
    `1.0.0+${"a".repeat(59)}`,
  ])("rejects invalid implementation version %s", (version) => {
    expect(() => createImplementationVersionSchema().parse(version)).toThrow();
  });

  it("accepts multi-digit semantic version components and identifiers", () => {
    const version = "12.34.56-alpha.12.beta+build.22";

    expect(createImplementationVersionSchema().parse(version)).toBe(version);
    expect(createImplementationVersionSchema().parse("1.2.3-alpha")).toBe("1.2.3-alpha");
  });

  it.each(["1.0.0-123", "1.0.0-12alpha", "1.0.0-alpha.12beta"])(
    "accepts the semantic prerelease identifier %s",
    (version) => {
      expect(createImplementationVersionSchema().parse(version)).toBe(version);
    },
  );

  it("reports the implementation version rule", () => {
    expect(() => createImplementationVersionSchema().parse("not-a-version")).toThrow(
      "Use a semantic implementation version.",
    );
  });

  it("defaults relationships and freezes their arrays", () => {
    const parsed = createInferenceProviderManifestSchema().parse(inferenceManifest);

    expect(parsed.requiredDependencies).toEqual([]);
    expect(parsed.optionalDependencies).toEqual([]);
    expect(parsed.conflicts).toEqual([]);
    expect(Object.isFrozen(parsed.requiredDependencies)).toBe(true);
    expect(Object.isFrozen(parsed.optionalDependencies)).toBe(true);
    expect(Object.isFrozen(parsed.conflicts)).toBe(true);
  });

  it("enforces configuration and relationship list boundaries", () => {
    const relationships = Array.from({ length: 32 }, (_, index) => `org.example.p${String(index)}`);

    expect(createPluginRelationshipsSchema().parse(relationships)).toHaveLength(32);
    expect(() =>
      createPluginRelationshipsSchema().parse([...relationships, "org.example.extra"]),
    ).toThrow();
    expect(() =>
      createPluginRelationshipsSchema().parse(["org.example.a", "org.example.a"]),
    ).toThrow("Plugin relationship IDs must be unique.");
    expect(createCommonManifestShape().configurationVersion.parse(1_000_000)).toBe(1_000_000);
    expect(() => createCommonManifestShape().configurationVersion.parse(0)).toThrow();
    expect(() => createCommonManifestShape().configurationVersion.parse(1.5)).toThrow();
    expect(() => createCommonManifestShape().configurationVersion.parse(1_000_001)).toThrow();
  });

  it("rejects every unsafe relationship combination", () => {
    expect(safeRelationshipMessage()).toBe(
      "Dependency and conflict IDs must not overlap or refer to the plugin itself.",
    );
    expect(
      hasSafeRelationships({
        id: "org.example.a",
        requiredDependencies: [],
        optionalDependencies: [],
        conflicts: [],
      }),
    ).toBe(true);
    expect(
      hasSafeRelationships({
        id: "org.example.a",
        requiredDependencies: ["org.example.a"],
        optionalDependencies: [],
        conflicts: [],
      }),
    ).toBe(false);
    expect(
      hasSafeRelationships({
        id: "org.example.a",
        requiredDependencies: [],
        optionalDependencies: ["org.example.a"],
        conflicts: [],
      }),
    ).toBe(false);
    expect(
      hasSafeRelationships({
        id: "org.example.a",
        requiredDependencies: ["org.example.b"],
        optionalDependencies: [],
        conflicts: ["org.example.b"],
      }),
    ).toBe(false);
  });
});

describe("inference provider manifest", () => {
  it("parses all declared capabilities and data classifications", () => {
    const capabilities = [
      "image-input",
      "prompt-caching",
      "reasoning-controls",
      "streaming",
      "structured-output",
      "tool-calls",
    ] as const;
    const dataClassifications = [
      "student-content",
      "student-identifier",
      "usage-metadata",
    ] as const;
    const parsed = createInferenceProviderManifestSchema().parse({
      ...inferenceManifest,
      capabilities,
      dataClassifications,
    });

    expect(parsed.capabilities).toEqual(capabilities);
    expect(parsed.dataClassifications).toEqual(dataClassifications);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);
    const provider = {
      stream: (): AsyncIterable<never> => ({
        [Symbol.asyncIterator]: (): AsyncIterator<never> => ({
          next: (): Promise<IteratorResult<never>> =>
            Promise.resolve({ done: true, value: undefined as never }),
        }),
      }),
    };
    const create = (): typeof provider => provider;
    const entry = defineInferenceProviderCatalogEntry({ create, manifest: parsed });
    expect(entry.manifest).toBe(parsed);
    expect(entry.create({ apiKey: "secret" })).toBe(provider);
  });

  it("creates safe provider errors without a diagnostic cause", () => {
    const error = new InferenceProviderError({
      code: "rate-limited",
      message: "The inference provider rate limit was reached.",
      retryAfterMs: 2_000,
      retryable: true,
    });

    expect(error).toMatchObject({
      code: "rate-limited",
      message: "The inference provider rate limit was reached.",
      name: "InferenceProviderError",
      retryAfterMs: 2_000,
      retryable: true,
    });
    expect(
      new InferenceProviderError({
        code: "authentication-failed",
        message: "Inference is unavailable.",
        retryable: false,
      }).retryAfterMs,
    ).toBeUndefined();
  });

  it.each([
    { apiVersion: "2.0" },
    { kind: "telemetry-exporter" },
    { runtimeTargets: ["dashboard-browser"] },
    { capabilities: ["streaming", "streaming"] },
    { capabilities: Array.from({ length: 17 }, () => "streaming") },
    { dataClassifications: [] },
    { dataClassifications: ["student-content", "student-content"] },
    { dataClassifications: ["private"] },
    { extra: true },
  ])("rejects incompatible inference fields %#", (change) => {
    expect(() =>
      createInferenceProviderManifestSchema().parse({ ...inferenceManifest, ...change }),
    ).toThrow();
  });

  it("reports duplicate inference capabilities and data classifications", () => {
    expect(() =>
      createInferenceProviderManifestSchema().parse({
        ...inferenceManifest,
        capabilities: ["streaming", "streaming"],
      }),
    ).toThrow("Capabilities must be unique.");
    expect(() =>
      createInferenceProviderManifestSchema().parse({
        ...inferenceManifest,
        dataClassifications: ["student-content", "student-content"],
      }),
    ).toThrow("Data classifications must be unique.");
  });
});

describe("telemetry exporter manifest", () => {
  it("parses all exporter capabilities, classifications, and destinations", () => {
    const capabilities = ["batch-export", "metric-export", "trace-export"] as const;
    const acceptedDataClassifications = ["operational", "pseudonymous", "student-content"] as const;
    const local = createTelemetryExporterManifestSchema().parse({
      ...telemetryManifest,
      capabilities,
      acceptedDataClassifications,
      destination: "local",
    });
    const external = createTelemetryExporterManifestSchema().parse(telemetryManifest);

    expect(local.capabilities).toEqual(capabilities);
    expect(local.acceptedDataClassifications).toEqual(acceptedDataClassifications);
    expect(external.destination).toBe("external");
    expect(Object.isFrozen(local.acceptedDataClassifications)).toBe(true);
    expect(defineTelemetryExporterCatalogEntry({ manifest: local }).manifest).toBe(local);
  });

  it.each([
    { apiVersion: "1.1" },
    { runtimeTargets: [] },
    { capabilities: [] },
    { capabilities: ["trace-export", "trace-export"] },
    { capabilities: ["network-export"] },
    { acceptedDataClassifications: [] },
    { acceptedDataClassifications: ["operational", "operational"] },
    { acceptedDataClassifications: ["secret"] },
    { destination: "browser" },
  ])("rejects incompatible telemetry fields %#", (change) => {
    expect(() =>
      createTelemetryExporterManifestSchema().parse({ ...telemetryManifest, ...change }),
    ).toThrow();
  });

  it("reports duplicate telemetry capabilities and data classifications", () => {
    expect(() =>
      createTelemetryExporterManifestSchema().parse({
        ...telemetryManifest,
        capabilities: ["trace-export", "trace-export"],
      }),
    ).toThrow("Capabilities must be unique.");
    expect(() =>
      createTelemetryExporterManifestSchema().parse({
        ...telemetryManifest,
        acceptedDataClassifications: ["operational", "operational"],
      }),
    ).toThrow("Data classifications must be unique.");
  });
});

describe("dashboard module manifest", () => {
  it("parses every dashboard capability and column boundary", () => {
    const capabilities = [
      "class-read",
      "evaluation-read",
      "run-read",
      "usage-read",
      "health-read",
    ] as const;
    const oneColumn = createDashboardModuleManifestSchema().parse({
      ...dashboardModuleManifest,
      capabilities,
      minimumColumns: 1,
    });
    const twelveColumns = createDashboardModuleManifestSchema().parse({
      ...dashboardModuleManifest,
      minimumColumns: 12,
    });

    expect(oneColumn.capabilities).toEqual(capabilities);
    expect(twelveColumns.minimumColumns).toBe(12);
    expect(
      defineDashboardModuleCatalogEntry({
        manifest: oneColumn,
        settingsSchema: z.strictObject({}),
        defaultSettings: {},
      }).manifest,
    ).toEqual(oneColumn);
  });

  it.each([
    { apiVersion: "0.9" },
    { runtimeTargets: ["teacher-server"] },
    { capabilities: [] },
    { capabilities: ["run-read", "run-read"] },
    { capabilities: ["write"] },
    { minimumColumns: 0 },
    { minimumColumns: 1.5 },
    { minimumColumns: 13 },
  ])("rejects incompatible dashboard module fields %#", (change) => {
    expect(() =>
      createDashboardModuleManifestSchema().parse({ ...dashboardModuleManifest, ...change }),
    ).toThrow();
  });

  it("defines a settingless module with a strict empty settings schema", () => {
    const { entry, settingsSchema } = defineSettinglessDashboardModule(dashboardModuleManifest);
    expect(entry.manifest).toEqual(
      createDashboardModuleManifestSchema().parse(dashboardModuleManifest),
    );
    expect(entry.defaultSettings).toEqual({});
    expect(settingsSchema.parse({})).toEqual({});
    expect(settingsSchema.safeParse({ extra: true }).success).toBe(false);
    expect(entry.settingsSchema.safeParse({ extra: true }).success).toBe(false);
    expect(() =>
      defineSettinglessDashboardModule({ ...dashboardModuleManifest, capabilities: [] }),
    ).toThrow();
  });

  it("reports duplicate dashboard module capabilities", () => {
    expect(() =>
      createDashboardModuleManifestSchema().parse({
        ...dashboardModuleManifest,
        capabilities: ["run-read", "run-read"],
      }),
    ).toThrow("Capabilities must be unique.");
  });
});

describe("dashboard theme manifest", () => {
  it("parses every theme capability", () => {
    const capabilities = ["dark-color-scheme", "high-contrast", "light-color-scheme"] as const;
    const parsed = createDashboardThemeManifestSchema().parse({
      ...dashboardThemeManifest,
      capabilities,
    });

    expect(parsed.capabilities).toEqual(capabilities);
    expect(
      defineDashboardThemeCatalogEntry({ manifest: parsed, tokens: fixtureThemeTokens }).manifest,
    ).toBe(parsed);
  });

  it.each([
    { apiVersion: "1.0" },
    { runtimeTargets: ["teacher-server"] },
    { capabilities: [] },
    { capabilities: ["high-contrast", "high-contrast"] },
    { capabilities: ["custom-css"] },
  ])("rejects incompatible dashboard theme fields %#", (change) => {
    expect(() =>
      createDashboardThemeManifestSchema().parse({ ...dashboardThemeManifest, ...change }),
    ).toThrow();
  });

  it("reports duplicate dashboard theme capabilities", () => {
    expect(() =>
      createDashboardThemeManifestSchema().parse({
        ...dashboardThemeManifest,
        capabilities: ["high-contrast", "high-contrast"],
      }),
    ).toThrow("Capabilities must be unique.");
  });
});
