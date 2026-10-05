import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  copiedPluginFixture,
  expectCatalogError,
  replaceFixtureText,
  temporaryRoot,
} from "../tests/fixtures/plugin-catalog/catalog-testkit.js";
import {
  catalogModeFromArguments,
  defaultCatalogFile,
  defaultPluginsDirectory,
  directCommandArguments,
  errorMessage,
  generatePluginCatalog,
  isFileSystemError,
  isPathOutsidePluginRoot,
  isUnsafeRelativePath,
  PluginCatalogError,
  runPluginCatalogCli,
} from "./generate-plugin-catalog.js";

const expectedFixtureCatalog = resolve(
  import.meta.dirname,
  "../tests/fixtures/plugin-catalog/expected-catalog.txt",
);

describe("plugin catalog generation", () => {
  it("discovers one typed fixture per kind with explicit static imports", async () => {
    const fixture = await copiedPluginFixture();
    const outputFile = join(fixture.root, "catalog.ts");
    const source = await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile,
      mode: "write",
    });

    expect(await readFile(outputFile, "utf8")).toBe(source);
    expect(
      catalogSnapshot(await readFile(join(fixture.root, "dashboard-browser-catalog.ts"), "utf8")),
    ).toBe(
      await readFile(
        resolve(
          import.meta.dirname,
          "../tests/fixtures/plugin-catalog/expected-browser-catalog.txt",
        ),
        "utf8",
      ),
    );
    expect(catalogSnapshot(source)).toBe(await readFile(expectedFixtureCatalog, "utf8"));
    expect(source).toContain(
      'import inferenceProviderPlugin0 from "./plugins/inference/synthetic-provider/src/index.js";',
    );
    expect(source).toContain(
      'import telemetryExporterPlugin0 from "./plugins/telemetry/synthetic-exporter/src/index.js";',
    );
    expect(source).toContain(
      "export const dashboardModuleCatalog: readonly DashboardModuleCatalogEntry[]",
    );
    expect(source).toContain(
      "export const dashboardThemeCatalog: readonly DashboardThemeCatalogEntry[]",
    );
    expect(source).toContain('"id":"org.marea.fixture-inference"');
    expect(source).toContain('"requiredDependencies":[]');
    expect(source).toContain('"optionalDependencies":[]');
    expect(source).not.toContain("tests/fixtures/plugin-catalog");
  });

  it("produces byte-identical output and passes drift checking", async () => {
    const fixture = await copiedPluginFixture();
    const outputFile = join(fixture.root, "generated", "catalog.ts");
    const first = await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile,
      mode: "write",
    });
    const second = await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile,
      mode: "check",
    });

    expect(second).toBe(first);
    expect(second).toContain('from "../plugins/dashboard-themes/synthetic-theme/src/index.js";');
  });

  it("discovers an added folder and orders it by manifest ID", async () => {
    const fixture = await copiedPluginFixture();
    const original = join(fixture.plugins, "inference", "synthetic-provider");
    const added = join(fixture.plugins, "inference", "zzz-added-provider");
    await cp(original, added, { recursive: true });
    await replaceFixtureText(
      join(added, "plugin.json"),
      "org.marea.fixture-inference",
      "org.marea.aaa-inference",
    );
    const source = await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile: join(fixture.root, "catalog.ts"),
      mode: "write",
    });

    expect(source.match(/import inferenceProviderPlugin/g)).toHaveLength(2);
    expect(source.indexOf("org.marea.aaa-inference")).toBeLessThan(
      source.indexOf("org.marea.fixture-inference"),
    );
  });

  it("removes a deleted folder without a registry switch edit", async () => {
    const fixture = await copiedPluginFixture();
    await rm(join(fixture.plugins, "telemetry", "synthetic-exporter"), { recursive: true });
    const source = await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile: join(fixture.root, "catalog.ts"),
      mode: "write",
    });

    expect(source).toContain(
      "export const telemetryExporterCatalog: readonly TelemetryExporterCatalogEntry[] = Object.freeze([]);",
    );
    expect(source).not.toContain("telemetryExporterPlugin0");
  });

  it("renders an empty catalog when plugin kind directories do not exist", async () => {
    const root = await temporaryRoot("marea-empty-plugin-catalog-");
    const source = await generatePluginCatalog({
      pluginsDirectory: join(root, "plugins"),
      outputFile: join(root, "catalog.ts"),
      mode: "write",
    });

    expect(await readFile(join(root, "dashboard-browser-catalog.ts"), "utf8")).toBe(
      await readFile(
        resolve(
          import.meta.dirname,
          "../tests/fixtures/plugin-catalog/expected-empty-browser-catalog.txt",
        ),
        "utf8",
      ),
    );
    expect(source).toBe(
      [
        "// This file is generated by scripts/generate-plugin-catalog.ts. Do not edit it.",
        "import type {",
        "  DashboardModuleCatalogEntry,",
        "  DashboardThemeCatalogEntry,",
        "  IdentityProviderCatalogEntry,",
        "  InferenceProviderCatalogEntry,",
        "  TelemetryExporterCatalogEntry,",
        '} from "@marea/plugin-api";',
        "",
        "export const identityProviderCatalog: readonly IdentityProviderCatalogEntry[] = Object.freeze([]);",
        "",
        "export const inferenceProviderCatalog: readonly InferenceProviderCatalogEntry[] = Object.freeze([]);",
        "",
        "export const telemetryExporterCatalog: readonly TelemetryExporterCatalogEntry[] = Object.freeze([]);",
        "",
        "export const dashboardModuleCatalog: readonly DashboardModuleCatalogEntry[] = Object.freeze([]);",
        "",
        "export const dashboardThemeCatalog: readonly DashboardThemeCatalogEntry[] = Object.freeze([]);",
        "",
        "export const dashboardCatalogRevision =",
        '  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";',
        "",
      ].join("\n"),
    );
  });

  it("keeps identity providers out of the dashboard revision and bounds their number", async () => {
    const fixture = await copiedPluginFixture();
    const revision = async () =>
      /"([a-f0-9]{64})"/u.exec(
        await generatePluginCatalog({
          pluginsDirectory: fixture.plugins,
          outputFile: join(fixture.root, "catalog.ts"),
          mode: "write",
        }),
      )?.[1];
    const withIdentity = await revision();
    const identity = join(fixture.plugins, "identity", "synthetic-identity");
    await rm(identity, { recursive: true });
    expect(await revision()).toBe(withIdentity);
    for (let index = 0; index < 8; index += 1) {
      const copy = join(fixture.plugins, "identity", `copy-${String(index)}`);
      await cp(
        resolve(
          import.meta.dirname,
          "../tests/fixtures/plugin-catalog/plugins/identity/synthetic-identity",
        ),
        copy,
        { recursive: true },
      );
      await replaceFixtureText(
        join(copy, "plugin.json"),
        "org.marea.fixture-identity",
        `org.marea.fixture-identity-${String(index)}`,
      );
    }
    const eight = await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile: join(fixture.root, "catalog.ts"),
      mode: "write",
    });
    expect(eight.match(/import identityProviderPlugin/gu)).toHaveLength(8);
    await cp(identity.replace("synthetic-identity", "copy-0"), identity, { recursive: true });
    await replaceFixtureText(
      join(identity, "plugin.json"),
      "org.marea.fixture-identity-0",
      "org.marea.fixture-identity-8",
    );
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile: join(fixture.root, "catalog.ts"),
        mode: "write",
      }),
      "INVALID_MANIFEST",
    );
  });

  it("rewrites only the final TypeScript suffix in a module specifier", async () => {
    const fixture = await copiedPluginFixture();
    const plugin = join(fixture.plugins, "inference", "synthetic-provider");
    await rename(join(plugin, "src"), join(plugin, "src.ts"));
    await replaceFixtureText(join(plugin, "plugin.json"), "./src/index.ts", "./src.ts/index.ts");
    const source = await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile: join(fixture.root, "catalog.ts"),
      mode: "write",
    });

    expect(source).toContain("/src.ts/index.js");
    expect(source).not.toContain("/src.js/index.ts");
  });

  it("reports missing and changed generated catalogs as drift", async () => {
    const fixture = await copiedPluginFixture();
    const outputFile = join(fixture.root, "catalog.ts");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile,
        mode: "check",
      }),
      "CATALOG_DRIFT",
      "Generate and commit",
    );
    await writeFile(outputFile, "stale\n", "utf8");
    await expectCatalogError(
      generatePluginCatalog({
        pluginsDirectory: fixture.plugins,
        outputFile,
        mode: "check",
      }),
      "CATALOG_DRIFT",
      "Regenerate and commit",
    );
  });
});

describe("plugin catalog command boundary", () => {
  it("selects write and check modes from the supported arguments", () => {
    expect(catalogModeFromArguments([])).toBe("write");
    expect(catalogModeFromArguments(["--check"])).toBe("check");
    expect(() => catalogModeFromArguments(["--write"])).toThrow("Usage");
    expect(() => catalogModeFromArguments(["--check", "extra"])).toThrow("Usage");
  });

  it("derives repository defaults and direct command arguments", () => {
    const repositoryRoot = resolve(import.meta.dirname, "..");

    expect(defaultPluginsDirectory()).toBe(resolve(repositoryRoot, "plugins"));
    expect(defaultCatalogFile()).toBe(
      resolve(repositoryRoot, "packages/plugin-runtime/src/generated/plugin-catalog.ts"),
    );
    expect(directCommandArguments(["bun", "generator.ts", "--check"])).toEqual(["--check"]);
    expect(directCommandArguments(["bun", "generator.ts"])).toEqual([]);
  });

  it("checks a generated catalog through the command boundary", async () => {
    const fixture = await copiedPluginFixture();
    const outputFile = join(fixture.root, "catalog.ts");
    await generatePluginCatalog({
      pluginsDirectory: fixture.plugins,
      outputFile,
      mode: "write",
    });

    await expect(
      runPluginCatalogCli(["--check"], fixture.plugins, outputFile),
    ).resolves.toBeUndefined();
  });

  it("writes a generated catalog through the command boundary", async () => {
    const fixture = await copiedPluginFixture();
    const outputFile = join(fixture.root, "catalog.ts");

    await runPluginCatalogCli([], fixture.plugins, outputFile);

    expect(catalogSnapshot(await readFile(outputFile, "utf8"))).toBe(
      await readFile(expectedFixtureCatalog, "utf8"),
    );
  });

  it("distinguishes parent traversal, sibling prefixes, and absolute relative results", () => {
    const parent = resolve("/catalog/plugins/example");

    expect(isPathOutsidePluginRoot(parent, dirname(parent))).toBe(true);
    expect(isPathOutsidePluginRoot(parent, resolve(parent, "..", "other", "index.ts"))).toBe(true);
    expect(isPathOutsidePluginRoot(parent, resolve(parent, "src", "index.ts"))).toBe(false);
    expect(isPathOutsidePluginRoot(parent, resolve(parent, "..evil", "index.ts"))).toBe(false);
    expect(isUnsafeRelativePath("/cross-drive/result.ts")).toBe(true);
  });

  it("narrows filesystem errors and renders boundary errors without assertions", () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });

    expect(isFileSystemError(missing, "ENOENT")).toBe(true);
    expect(isFileSystemError(missing, "EACCES")).toBe(false);
    expect(isFileSystemError({ code: "ENOENT" }, "ENOENT")).toBe(false);
    expect(isFileSystemError("ENOENT", "ENOENT")).toBe(false);
    expect(errorMessage(new Error("failed"))).toBe("Error: failed");
    expect(errorMessage("failed")).toBe("failed");
  });

  it("keeps structured catalog error identity and context", () => {
    const error = new PluginCatalogError("INVALID_LAYOUT", "plugins/example", "Fix it.");

    expect(error.name).toBe("PluginCatalogError");
    expect(error.message).toBe("INVALID_LAYOUT at plugins/example: Fix it.");
    expect(error).toMatchObject({ code: "INVALID_LAYOUT", location: "plugins/example" });
  });
});

// Source artifact hashes legitimately change when mutation instrumentation rewrites fixtures.
// Revision format, stability, sensitivity and shared browser/server identity are tested separately.
function catalogSnapshot(source: string): string {
  return source.replace(/"[a-f0-9]{64}"/, '"CATALOG_REVISION"');
}
