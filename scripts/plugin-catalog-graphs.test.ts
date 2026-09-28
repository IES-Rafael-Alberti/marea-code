import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  copiedPluginFixture,
  temporaryRoot,
} from "../tests/fixtures/plugin-catalog/catalog-testkit.js";
import { validateDashboardGraph } from "./plugin-catalog/graphs.js";
import { discoverCatalog } from "./plugin-catalog/discovery.js";

it.each([
  "export const value = navigator;",
  "export const value = HTMLElement;",
  "export default () => <div>text</div>;",
  "export default () => <>text</>;",
  'import fs = require("node:fs");',
  'const fs = require("node:fs");',
  "const fs = require();",
  "const fs = require(1);",
  "export const load = () => import(variable);",
])("rejects unsupported pure graph source %# with a structured diagnostic", async (text) => {
  const root = await temporaryRoot();
  const entry = join(root, "entry.tsx");
  await writeFile(entry, text);
  await expect(validateDashboardGraph(entry, false)).rejects.toMatchObject({
    code: "INVALID_MANIFEST",
    location: entry,
  });
});
it("rejects pure-to-browser edges even for a browser artifact without React or DOM", async () => {
  const root = await temporaryRoot();
  const entry = join(root, "entry.ts");
  const browser = join(root, "browser.ts");
  await writeFile(entry, 'export * from "./browser.js";');
  await writeFile(browser, "export const value = 1;");
  await expect(validateDashboardGraph(entry, false, browser)).rejects.toThrow(
    "Dashboard import graph",
  );
});
it("accepts pure public contracts, browser JSX runtime and ordinary method calls", async () => {
  const root = await temporaryRoot();
  const entry = join(root, "entry.ts");
  await writeFile(entry, 'import "@marea/plugin-api"; import "zod"; Math.max(1, 2); export {};');
  await expect(validateDashboardGraph(entry, false)).resolves.toMatch(/^[a-f0-9]{64}$/);
  await writeFile(
    entry,
    'import "react/jsx-runtime"; import "@marea/plugin-api/browser"; export {};',
  );
  await expect(validateDashboardGraph(entry, true)).resolves.toMatch(/^[a-f0-9]{64}$/);
});
it("does not apply dashboard graph policy or artifact hashing to server plugins", async () => {
  const fixture = await copiedPluginFixture();
  for (const [kind, name] of [
    ["inference", "synthetic-provider"],
    ["telemetry", "synthetic-exporter"],
  ] as const) {
    const file = join(fixture.plugins, kind, name, "src/index.ts");
    await writeFile(file, 'import "node:fs";\n' + (await readFile(file, "utf8")));
  }
  const catalog = await discoverCatalog(fixture.plugins);
  expect(catalog.inferenceProviders[0]?.artifactRevision).toBeUndefined();
  expect(catalog.telemetryExporters[0]?.artifactRevision).toBeUndefined();
  expect(catalog.dashboardModules[0]?.artifactRevision).toMatch(/^[a-f0-9]{128}$/);
  expect(catalog.dashboardThemes[0]?.artifactRevision).toMatch(/^[a-f0-9]{64}$/);
});

it("resolves only the final source suffix inside dotted directories", async () => {
  const root = await temporaryRoot();
  const entry = join(root, "entry.ts");
  await mkdir(join(root, "part.js"));
  await mkdir(join(root, "part.ts"));
  await writeFile(join(root, "part.js", "helper.ts"), "export const one = 1;");
  await writeFile(join(root, "part.ts", "helper.tsx"), "export const two = 2;");
  await writeFile(
    entry,
    'export * from "./part.js/helper.js"; export * from "./part.ts/helper.js";',
  );
  await expect(validateDashboardGraph(entry, false)).resolves.toMatch(/^[a-f0-9]{64}$/);
});

it("allows literal lazy imports inside a pure graph", async () => {
  const root = await temporaryRoot();
  const entry = join(root, "entry.ts");
  await writeFile(join(root, "helper.ts"), "export const setting = 1;");
  await writeFile(entry, 'export const load = () => import("./helper.js");');
  await expect(validateDashboardGraph(entry, false)).resolves.toMatch(/^[a-f0-9]{64}$/);
});
it("does not treat the relative public browser API as a pure API entry", async () => {
  const root = await temporaryRoot();
  const entry = join(root, "entry.ts");
  const browser = relative(
    root,
    resolve(import.meta.dirname, "../packages/plugin-api/src/browser.ts"),
  ).replace(/\.ts$/, ".js");
  await writeFile(entry, `export * from ${JSON.stringify(browser)};`);
  await expect(validateDashboardGraph(entry, false)).rejects.toThrow("Dashboard import graph");
});
