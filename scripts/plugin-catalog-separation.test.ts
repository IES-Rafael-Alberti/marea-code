import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  copiedPluginFixture,
  replaceFixtureText,
} from "../tests/fixtures/plugin-catalog/catalog-testkit.js";
import { generatePluginCatalog } from "./generate-plugin-catalog.js";

async function generate(
  fixture: { root: string; plugins: string },
  mode: "write" | "check" = "write",
) {
  return generatePluginCatalog({
    pluginsDirectory: fixture.plugins,
    outputFile: join(fixture.root, "catalog.ts"),
    mode,
  });
}
function revision(source: string) {
  return /dashboardCatalogRevision =\s*"([a-f0-9]{64})"/.exec(source)?.[1];
}

describe("generated dashboard catalog separation", () => {
  it("emits browser-only lazy entries with the same path-independent revision", async () => {
    const fixture = await copiedPluginFixture();
    const server = await generate(fixture);
    const browser = await readFile(join(fixture.root, "dashboard-browser-catalog.ts"), "utf8");
    expect(revision(server)).toMatch(/^[a-f0-9]{64}$/);
    expect(revision(browser)).toBe(revision(server));
    expect(browser).toContain(
      '() =>\n    import("./plugins/dashboard-modules/synthetic-module/src/browser.js")',
    );
    expect(browser).toContain(
      '() =>\n    import("./plugins/dashboard-themes/synthetic-theme/src/index.js")',
    );
    expect(browser).toContain("export const dashboardModuleDescriptorLoaders = Object.freeze({");
    expect(browser).toContain(
      '() =>\n    import("./plugins/dashboard-modules/synthetic-module/src/index.js")',
    );
    expect(browser).not.toMatch(/inference|telemetry|node:|apiKey/);
    expect(server).not.toContain("src/browser.js");
    const another = await copiedPluginFixture();
    expect(revision(await generate(another))).toBe(revision(server));
    await replaceFixtureText(
      join(fixture.plugins, "dashboard-modules/synthetic-module/plugin.json"),
      '"configurationVersion": 1',
      '"configurationVersion": 2',
    );
    expect(revision(await generate(fixture))).not.toBe(revision(server));
  });
  it("discovers dashboard additions/removals without a central registry edit and checks browser drift", async () => {
    const fixture = await copiedPluginFixture();
    const original = join(fixture.plugins, "dashboard-modules/synthetic-module");
    const added = join(fixture.plugins, "dashboard-modules/added-module");
    await cp(original, added, { recursive: true });
    await replaceFixtureText(
      join(added, "plugin.json"),
      "org.marea.fixture-dashboard-module",
      "org.marea.added-module",
    );
    await generate(fixture);
    const browserFile = join(fixture.root, "dashboard-browser-catalog.ts");
    const addedSource = await readFile(browserFile, "utf8");
    expect(addedSource).toContain("org.marea.added-module");
    expect(addedSource).toMatch(/\),\n {2}"org\.marea\.fixture-dashboard-module":/);
    await rm(added, { recursive: true });
    await generate(fixture);
    expect(await readFile(browserFile, "utf8")).not.toContain("org.marea.added-module");
    await writeFile(browserFile, "stale");
    await expect(generate(fixture, "check")).rejects.toMatchObject({ code: "CATALOG_DRIFT" });
  });
  it.each([
    ['export { default } from "./browser.js";', "index.ts"],
    ['export const load = () => import("./browser.js");', "index.ts"],
    ['import React from "react"; export default React;', "index.ts"],
    ["export const bad = document;", "index.ts"],
    ["export const bad = window;", "index.ts"],
    ["export const load = (path: string) => import(path);", "browser.ts"],
    ['import fs from "node:fs"; export default fs;', "browser.ts"],
    ['export { default } from "../../../inference/synthetic-provider/src/index.js";', "browser.ts"],
    ['export { default } from "../../../telemetry/synthetic-exporter/src/index.js";', "browser.ts"],
    ['import type { DashboardModuleContext } from "@marea/plugin-api/browser";', "index.ts"],
  ])("rejects graph contamination %#", async (source, file) => {
    const fixture = await copiedPluginFixture();
    await writeFile(join(fixture.plugins, "dashboard-modules/synthetic-module/src", file), source);
    await expect(generate(fixture)).rejects.toThrow("Dashboard import graph");
  });
  it("walks transitive reexports and dynamic imports rather than trusting entrypoint names", async () => {
    const fixture = await copiedPluginFixture();
    const root = join(fixture.plugins, "dashboard-modules/synthetic-module/src");
    await writeFile(join(root, "browser.ts"), 'export { load } from "./helper.js";');
    await writeFile(join(root, "helper.ts"), 'export const load = () => import("node:fs");');
    await expect(generate(fixture)).rejects.toThrow("Dashboard import graph");
    await writeFile(
      join(root, "helper.ts"),
      'export * from "./helper.js"; export const load = () => 1;',
    );
    await expect(generate(fixture)).resolves.toContain("dashboardModuleCatalog");
  });
});

describe("dashboard release limits and graph branches", () => {
  it.each([
    ["dashboard-modules", "synthetic-module", 65],
    ["dashboard-themes", "synthetic-theme", 17],
  ] as const)("rejects excessive %s", async (kind, name, count) => {
    const fixture = await copiedPluginFixture();
    const original = join(fixture.plugins, kind, name);
    for (let index = 1; index < count; index++) {
      const added = join(fixture.plugins, kind, `added-${String(index)}`);
      await cp(original, added, { recursive: true });
      const file = join(added, "plugin.json");
      const text = await readFile(file, "utf8");
      await writeFile(
        file,
        text.replace(/"id": "[^"]+"/, `"id": "org.marea.added-${String(index)}"`),
      );
    }
    const excessive = generate(fixture);
    await expect(excessive).rejects.toThrow("Dashboard catalog exceeds release bounds.");
    await expect(excessive).rejects.toHaveProperty("code", "INVALID_MANIFEST");
    await rm(join(fixture.plugins, kind, `added-${String(count - 1)}`), { recursive: true });
    await expect(generate(fixture)).resolves.toContain("dashboardCatalogRevision");
  });
  it("accepts React imports only in the browser graph and hashes changed artifacts", async () => {
    const fixture = await copiedPluginFixture();
    const file = join(fixture.plugins, "dashboard-modules/synthetic-module/src/browser.ts");
    const first = revision(await generate(fixture));
    await writeFile(file, 'import React from "react"; export { React };');
    expect(revision(await generate(fixture))).not.toBe(first);
    await writeFile(
      file,
      'import "@marea/plugin-api/browser"; import "zod"; Math.max(1, 2); export {};',
    );
    await expect(generate(fixture)).resolves.toContain("dashboardModuleCatalog");
  });
});

it("refuses to render a dashboard module without a validated browser entry", async () => {
  const { discoverCatalog } = await import("./plugin-catalog/discovery.js");
  const { renderBrowserCatalog } = await import("./plugin-catalog/rendering.js");
  const fixture = await copiedPluginFixture();
  const catalog = await discoverCatalog(fixture.plugins);
  const incomplete = {
    ...catalog,
    dashboardModules: catalog.dashboardModules.map(({ manifest, entrypointFile }) => ({
      manifest,
      entrypointFile,
    })),
  };
  expect(() => renderBrowserCatalog(incomplete, join(fixture.root, "browser.ts"))).toThrow(
    "Dashboard module browser entrypoint is missing.",
  );
});

it("follows browser TSX implementations while rejecting JSX in pure entries", async () => {
  const fixture = await copiedPluginFixture();
  const root = join(fixture.plugins, "dashboard-modules/synthetic-module/src");
  await writeFile(join(root, "browser.ts"), 'export { default } from "./component.js";');
  await writeFile(
    join(root, "component.tsx"),
    'import React from "react"; export default () => <div />;',
  );
  await expect(generate(fixture)).resolves.toContain("dashboardModuleCatalog");
  await writeFile(join(root, "index.ts"), 'export { default } from "./component.js";');
  await expect(generate(fixture)).rejects.toThrow("Dashboard import graph");
});
