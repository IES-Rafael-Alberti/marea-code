import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { moduleFixture } from "../packages/plugin-api/src/dashboard.fixture.js";
import { temporaryRoot } from "../tests/fixtures/plugin-catalog/catalog-testkit.js";
import { catalogRevision } from "./plugin-catalog/rendering.js";
import { validateDashboardGraph } from "./plugin-catalog/graphs.js";

it("pins canonical public metadata hashing independently of fixture source instrumentation", () => {
  const source = {
    manifest: {
      ...moduleFixture.manifest,
      requiredServerCapabilities: ["sessions/v1", "usage/v1"],
    },
    entrypointFile: "/machine/one/index.ts",
    artifactRevision: "a".repeat(64),
  };
  const catalog = {
    identityProviders: [],
    inferenceProviders: [],
    telemetryExporters: [],
    dashboardModules: [source],
    dashboardThemes: [],
  };
  const expected = "0b6c9a288380f17565541a034bc89e32b334dc453672670e7212cd8f8a9e2983";
  expect(catalogRevision(catalog)).toBe(expected);
  const { id, ...metadata } = source.manifest;
  expect(
    catalogRevision({
      ...catalog,
      dashboardModules: [
        {
          ...source,
          entrypointFile: "/different/machine/index.ts",
          manifest: {
            ...metadata,
            id,
            entrypoint: "./different.ts",
            browserEntrypoint: "./other.ts",
          },
        },
      ],
    }),
  ).toBe(expected);
});
it("pins the transitive artifact digest without machine paths", async () => {
  const root = await temporaryRoot();
  const entry = join(root, "entry.ts");
  await writeFile(entry, "export * from './helper.js';");
  await writeFile(join(root, "helper.ts"), "export const setting = 1;");
  expect(await validateDashboardGraph(entry, false)).toBe(
    "0cabe2b9dcff8326dcb60ac8df67371339ba04bf4eabaf2f2de1b379c7f55d78",
  );
});
