import { expect, it } from "vitest";
import { format } from "prettier";
import { moduleFixture } from "../packages/plugin-api/src/dashboard.fixture.js";
import { renderBrowserCatalog } from "./plugin-catalog/rendering.js";
it.each([99, 100, 101])("keeps generated lazy imports formatted at %i columns", async (length) => {
  const prefix = '  "org.marea.a": () =>';
  const base = `${prefix} import("./.js"),`;
  const name = "x".repeat(length - base.length);
  const path = `/release/${name}.ts`;
  const source = renderBrowserCatalog(
    {
      inferenceProviders: [],
      telemetryExporters: [],
      dashboardThemes: [],
      dashboardModules: [
        {
          manifest: { ...moduleFixture.manifest, id: "org.marea.a" },
          entrypointFile: path,
          browserEntrypointFile: path,
          artifactRevision: "a".repeat(64),
        },
      ],
    },
    "/release/catalog.ts",
  );
  const expression = `import("./${name}.js"),`;
  expect(source).toContain(
    length > 100 ? `${prefix}\n    ${expression}` : `${prefix} ${expression}`,
  );
  expect(await format(source, { parser: "typescript", printWidth: 100 })).toBe(source);
});
