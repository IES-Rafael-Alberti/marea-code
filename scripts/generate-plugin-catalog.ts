import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { discoverCatalog } from "./plugin-catalog/discovery.js";
import { errorMessage, isFileSystemError, PluginCatalogError } from "./plugin-catalog/errors.js";
import { renderBrowserCatalog, renderCatalog } from "./plugin-catalog/rendering.js";

export { isPathOutsidePluginRoot, isUnsafeRelativePath } from "./plugin-catalog/discovery.js";
export {
  errorMessage,
  isFileSystemError,
  PluginCatalogError,
  type PluginCatalogErrorCode,
} from "./plugin-catalog/errors.js";

export function defaultPluginsDirectory(): string {
  return resolve(import.meta.dirname, "..", "plugins");
}

export function defaultCatalogFile(): string {
  return resolve(
    import.meta.dirname,
    "..",
    "packages/plugin-runtime/src/generated/plugin-catalog.ts",
  );
}

export function directCommandArguments(arguments_: readonly string[]): readonly string[] {
  return arguments_.slice(2);
}

export type PluginCatalogMode = "write" | "check";

export interface GeneratePluginCatalogOptions {
  readonly pluginsDirectory: string;
  readonly outputFile: string;
  readonly mode: PluginCatalogMode;
}

export async function generatePluginCatalog(
  options: GeneratePluginCatalogOptions,
): Promise<string> {
  const pluginsDirectory = resolve(options.pluginsDirectory);
  const outputFile = resolve(options.outputFile);
  const catalog = await discoverCatalog(pluginsDirectory);
  const source = renderCatalog(catalog, outputFile);
  const browserFile = resolve(dirname(outputFile), "dashboard-browser-catalog.ts");
  const browserSource = renderBrowserCatalog(catalog, browserFile);

  if (options.mode === "write") {
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, source);
    await writeFile(browserFile, browserSource);
    return source;
  }

  await assertCatalogCurrent(outputFile, source);
  await assertCatalogCurrent(browserFile, browserSource);
  return source;
}

export function catalogModeFromArguments(arguments_: readonly string[]): PluginCatalogMode {
  if (arguments_.length === 0) {
    return "write";
  }
  if (arguments_.length === 1 && arguments_[0] === "--check") {
    return "check";
  }
  throw new TypeError("Usage: generate-plugin-catalog.ts [--check]");
}

export async function runPluginCatalogCli(
  arguments_: readonly string[],
  pluginsDirectory: string,
  outputFile: string,
): Promise<void> {
  await generatePluginCatalog({
    pluginsDirectory,
    outputFile,
    mode: catalogModeFromArguments(arguments_),
  });
}

async function assertCatalogCurrent(outputFile: string, expected: string): Promise<void> {
  let actual: string;
  try {
    actual = new TextDecoder().decode(await readFile(outputFile));
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new PluginCatalogError(
        "CATALOG_DRIFT",
        outputFile,
        "Generate and commit the plugin catalog.",
      );
    }
    throw new PluginCatalogError("READ_FAILED", outputFile, errorMessage(error));
  }
  if (actual !== expected) {
    throw new PluginCatalogError(
      "CATALOG_DRIFT",
      outputFile,
      "Regenerate and commit the deterministic plugin catalog.",
    );
  }
}

// Stryker disable next-line ConditionalExpression, BlockStatement: Bun controls direct execution.
/* v8 ignore start */
if (import.meta.main) {
  await runPluginCatalogCli(
    directCommandArguments(process.argv),
    defaultPluginsDirectory(),
    defaultCatalogFile(),
  );
}
/* v8 ignore stop */
