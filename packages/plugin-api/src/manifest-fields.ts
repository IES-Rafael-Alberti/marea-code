import * as z from "zod";

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function createPluginIdSchema() {
  return z
    .string()
    .max(160)
    .regex(
      /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/,
      "Use a lowercase reverse-domain or Marea-owned plugin ID.",
    );
}

export function createTranslationKeySchema() {
  return z
    .string()
    .max(160)
    .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/, "Use a portable translation key.");
}

export function createImplementationVersionSchema() {
  return z
    .string()
    .max(64)
    .regex(
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      "Use a semantic implementation version.",
    );
}

export function createPluginEntrypointSchema() {
  return z
    .string()
    .max(240)
    .regex(
      /^\.\/(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.ts$/,
      "Use a relative TypeScript entrypoint without parent traversal.",
    );
}

export function createPluginRelationshipsSchema() {
  return z
    .array(createPluginIdSchema())
    .max(32)
    .refine(hasUniqueStrings, "Plugin relationship IDs must be unique.")
    .readonly();
}

export function createCommonManifestShape() {
  return {
    id: createPluginIdSchema(),
    displayNameKey: createTranslationKeySchema(),
    descriptionKey: createTranslationKeySchema(),
    implementationVersion: createImplementationVersionSchema(),
    entrypoint: createPluginEntrypointSchema(),
    configurationVersion: z.number().int().positive().max(1_000_000),
    requiredDependencies: createPluginRelationshipsSchema().default([]).readonly(),
    optionalDependencies: createPluginRelationshipsSchema().default([]).readonly(),
    conflicts: createPluginRelationshipsSchema().default([]).readonly(),
  } as const;
}

export interface PluginRelationships {
  readonly id: string;
  readonly requiredDependencies: readonly string[];
  readonly optionalDependencies: readonly string[];
  readonly conflicts: readonly string[];
}

export function hasSafeRelationships(manifest: PluginRelationships): boolean {
  const relationships = [
    ...manifest.requiredDependencies,
    ...manifest.optionalDependencies,
    ...manifest.conflicts,
  ];
  return (
    !relationships.includes(manifest.id) && new Set(relationships).size === relationships.length
  );
}

export function safeRelationshipMessage(): string {
  return "Dependency and conflict IDs must not overlap or refer to the plugin itself.";
}
