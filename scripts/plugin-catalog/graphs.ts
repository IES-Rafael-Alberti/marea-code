import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { PluginCatalogError } from "./errors.js";

/** Validate every reachable local edge, including dynamic imports and re-exports. */
export async function validateDashboardGraph(
  entrypoint: string,
  browser: boolean,
  browserEntrypoint?: string,
): Promise<string> {
  const artifacts: string[] = [];
  const visited = new Set<string>();
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    if (!browser && file === browserEntrypoint) fail(file);
    const text = await readFile(file, "utf8");
    artifacts.push(createHash("sha256").update(text).digest("hex"));
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    const dependencies = ts
      .preProcessFile(text, true, true)
      .importedFiles.map((dependency) => dependency.fileName);
    function inspect(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument)) fail(file);
      }
      if (
        !browser &&
        ((ts.isIdentifier(node) &&
          ["window", "document", "navigator", "HTMLElement"].includes(node.text)) ||
          ts.isJsxElement(node) ||
          ts.isJsxSelfClosingElement(node) ||
          ts.isJsxFragment(node))
      )
        fail(file);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    for (const dependency of dependencies) {
      if (["zod", "@marea/plugin-api", "@marea/plugin-api/browser"].includes(dependency)) {
        if (!browser && dependency.endsWith("/browser")) fail(file);
        continue;
      }
      if (browser && ["react", "react/jsx-runtime"].includes(dependency)) continue;
      if (!dependency.startsWith(".")) fail(file);
      const target = localDependency(file, dependency);
      if (target.includes("/packages/plugin-api/src/") && !target.endsWith("/browser.ts")) continue;
      if (
        target.includes("/apps/") ||
        target.includes("/plugins/inference/") ||
        target.includes("/plugins/telemetry/")
      )
        fail(file);
      await visit(target);
    }
  }
  await visit(entrypoint);
  return createHash("sha256").update(artifacts.sort().join(":")).digest("hex");
}
function fail(location: string): never {
  throw new PluginCatalogError(
    "INVALID_MANIFEST",
    location,
    "Dashboard import graph crosses its pure/browser boundary. Use public dashboard ports.",
  );
}

function localDependency(file: string, dependency: string): string {
  const candidate = resolve(dirname(file), dependency.replace(/\.js$/, ".ts"));
  return ts.sys.fileExists(candidate) ? candidate : candidate.replace(/\.ts$/, ".tsx");
}
