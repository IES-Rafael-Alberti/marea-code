import type { Dirent, Stats } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  createDashboardModuleManifestSchema,
  createDashboardThemeManifestSchema,
  createIdentityProviderManifestSchema,
  createInferenceProviderManifestSchema,
  createTelemetryExporterManifestSchema,
  type DashboardModuleManifest,
  type DashboardThemeManifest,
  type IdentityProviderManifest,
  type InferenceProviderManifest,
  type TelemetryExporterManifest,
} from "../../packages/plugin-api/src/index.js";
import type { ZodType } from "zod";

import {
  errorMessage,
  isFileSystemError,
  PluginCatalogError,
  type PluginCatalogErrorCode,
} from "./errors.js";

import { validateDashboardGraph } from "./graphs.js";

export interface ManifestSource<
  Manifest extends { readonly entrypoint: string; readonly id: string },
> {
  readonly manifest: Manifest;
  readonly entrypointFile: string;
  readonly browserEntrypointFile?: string;
  readonly artifactRevision?: string;
}

export interface DiscoveredCatalog {
  readonly identityProviders: readonly ManifestSource<IdentityProviderManifest>[];
  readonly inferenceProviders: readonly ManifestSource<InferenceProviderManifest>[];
  readonly telemetryExporters: readonly ManifestSource<TelemetryExporterManifest>[];
  readonly dashboardModules: readonly ManifestSource<DashboardModuleManifest>[];
  readonly dashboardThemes: readonly ManifestSource<DashboardThemeManifest>[];
}

export async function discoverCatalog(pluginsDirectory: string): Promise<DiscoveredCatalog> {
  await validatePluginRoot(pluginsDirectory);
  const identityProviders = await discoverKind(
    pluginsDirectory,
    "identity",
    createIdentityProviderManifestSchema(),
  );
  const inferenceProviders = await discoverKind(
    pluginsDirectory,
    "inference",
    createInferenceProviderManifestSchema(),
  );
  const telemetryExporters = await discoverKind(
    pluginsDirectory,
    "telemetry",
    createTelemetryExporterManifestSchema(),
  );
  const dashboardModules = await discoverKind(
    pluginsDirectory,
    "dashboard-modules",
    createDashboardModuleManifestSchema(),
  );
  const dashboardThemes = await discoverKind(
    pluginsDirectory,
    "dashboard-themes",
    createDashboardThemeManifestSchema(),
  );
  if (dashboardModules.length > 64 || dashboardThemes.length > 16 || identityProviders.length > 8) {
    throw new PluginCatalogError(
      "INVALID_MANIFEST",
      pluginsDirectory,
      "Dashboard catalog exceeds release bounds.",
    );
  }
  rejectDuplicateIds([
    ...identityProviders,
    ...inferenceProviders,
    ...telemetryExporters,
    ...dashboardModules,
    ...dashboardThemes,
  ]);
  return {
    identityProviders,
    inferenceProviders,
    telemetryExporters,
    dashboardModules,
    dashboardThemes,
  };
}

async function validatePluginRoot(pluginsDirectory: string): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(pluginsDirectory);
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      return;
    }
    throw new PluginCatalogError("READ_FAILED", pluginsDirectory, errorMessage(error));
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new PluginCatalogError(
      "INVALID_LAYOUT",
      pluginsDirectory,
      "The plugin root must be a real directory, not a file or symbolic link.",
    );
  }
  const entries = await readDirectoryIfPresent(pluginsDirectory);
  for (const entry of entries) {
    if (!isPluginKindDirectory(entry.name)) {
      throw new PluginCatalogError(
        "INVALID_LAYOUT",
        entry.name,
        "Remove the unknown top-level plugin kind.",
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new PluginCatalogError(
        "INVALID_LAYOUT",
        entry.name,
        "Plugin kind entries must be real directories, not files or symbolic links.",
      );
    }
  }
}

async function discoverKind<
  Manifest extends
    | DashboardModuleManifest
    | DashboardThemeManifest
    | IdentityProviderManifest
    | InferenceProviderManifest
    | TelemetryExporterManifest,
>(
  pluginsDirectory: string,
  kindDirectoryName: string,
  schema: ZodType<Manifest>,
): Promise<readonly ManifestSource<Manifest>[]> {
  const kindDirectory = resolve(pluginsDirectory, kindDirectoryName);
  const entries = await readDirectoryIfPresent(kindDirectory);
  const plugins: ManifestSource<Manifest>[] = [];

  for (const entry of entries) {
    assertPluginDirectory(entry, kindDirectoryName);
    const pluginDirectory = resolve(kindDirectory, entry.name);
    const manifest = await readManifest(pluginDirectory, schema);
    const entrypointFile = await checkedEntrypoint(pluginDirectory, manifest.entrypoint);
    let browserEntrypointFile: string | undefined;
    let artifactRevision = "";
    if (manifest.kind === "dashboard-module") {
      browserEntrypointFile = await checkedEntrypoint(pluginDirectory, manifest.browserEntrypoint);
      artifactRevision += await validateDashboardGraph(browserEntrypointFile, true);
    }
    if (kindDirectoryName.startsWith("dashboard-"))
      artifactRevision += await validateDashboardGraph(
        entrypointFile,
        false,
        browserEntrypointFile,
      );
    plugins.push({
      manifest,
      entrypointFile,
      ...(browserEntrypointFile ? { browserEntrypointFile } : {}),
      ...(artifactRevision ? { artifactRevision } : {}),
    });
  }

  return plugins.toSorted((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

async function readDirectoryIfPresent(directory: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      return [];
    }
    throw new PluginCatalogError("READ_FAILED", directory, errorMessage(error));
  }
}

function assertPluginDirectory(entry: Dirent, kindDirectoryName: string): void {
  const location = `${kindDirectoryName}/${entry.name}`;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new PluginCatalogError(
      "INVALID_LAYOUT",
      location,
      "Keep only real plugin directories directly below each plugin kind.",
    );
  }
  if (!isPluginDirectoryName(entry.name)) {
    throw new PluginCatalogError(
      "INVALID_LAYOUT",
      location,
      "Use a portable lowercase plugin directory name.",
    );
  }
}

function isPluginKindDirectory(name: string): boolean {
  return ["dashboard-modules", "dashboard-themes", "identity", "inference", "telemetry"].includes(
    name,
  );
}

function isPluginDirectoryName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

async function readManifest<Manifest extends { readonly entrypoint: string; readonly id: string }>(
  pluginDirectory: string,
  schema: ZodType<Manifest>,
): Promise<Manifest> {
  const manifestFile = resolve(pluginDirectory, "plugin.json");
  const stats = await requiredStats(
    manifestFile,
    "INVALID_MANIFEST",
    "Add a regular plugin.json file.",
  );
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PluginCatalogError(
      "INVALID_MANIFEST",
      manifestFile,
      "plugin.json must be a regular file, not a directory or symbolic link.",
    );
  }
  const text = await readUtf8(manifestFile);
  const value = parseJson(text, manifestFile);
  const result = schema.safeParse(value);
  if (!result.success) {
    const diagnostic = result.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new PluginCatalogError("INVALID_MANIFEST", manifestFile, diagnostic);
  }
  return result.data;
}

function parseJson(text: string, manifestFile: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PluginCatalogError(
      "INVALID_MANIFEST",
      manifestFile,
      "plugin.json must contain valid JSON.",
    );
  }
}

async function checkedEntrypoint(
  pluginDirectory: string,
  manifestEntrypoint: string,
): Promise<string> {
  const entrypointFile = resolve(pluginDirectory, manifestEntrypoint);
  const stats = await requiredStats(
    entrypointFile,
    "ENTRYPOINT_NOT_FOUND",
    "Add the manifest's TypeScript entrypoint.",
  );
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PluginCatalogError(
      "UNSAFE_PATH",
      entrypointFile,
      "The entrypoint must be a regular file, not a directory or symbolic link.",
    );
  }
  const [realPluginDirectory, realEntrypointFile] = await Promise.all([
    realpath(pluginDirectory),
    realpath(entrypointFile),
  ]);
  if (isPathOutsidePluginRoot(realPluginDirectory, realEntrypointFile)) {
    throw new PluginCatalogError(
      "UNSAFE_PATH",
      entrypointFile,
      "The entrypoint resolves outside its plugin directory.",
    );
  }
  return entrypointFile;
}

async function requiredStats(
  path: string,
  code: PluginCatalogErrorCode,
  missingMessage: string,
): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new PluginCatalogError(code, path, missingMessage);
    }
    throw new PluginCatalogError("READ_FAILED", path, errorMessage(error));
  }
}

export function isPathOutsidePluginRoot(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return isUnsafeRelativePath(relativePath);
}

export function isUnsafeRelativePath(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function rejectDuplicateIds(
  sources: readonly ManifestSource<
    | DashboardModuleManifest
    | DashboardThemeManifest
    | IdentityProviderManifest
    | InferenceProviderManifest
    | TelemetryExporterManifest
  >[],
): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.manifest.id)) {
      throw new PluginCatalogError(
        "DUPLICATE_PLUGIN_ID",
        source.manifest.id,
        "Give every plugin a globally unique ID.",
      );
    }
    seen.add(source.manifest.id);
  }
}

async function readUtf8(path: string): Promise<string> {
  return new TextDecoder().decode(await readFile(path));
}
