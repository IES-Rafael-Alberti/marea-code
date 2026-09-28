import { readdirSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";

const firstPartyCode = "^(apps|packages|plugins|scripts)/";

function directoryNames(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
}

function pluginIsolationRules() {
  const pluginsRoot = resolve(process.cwd(), "plugins");
  return directoryNames(pluginsRoot).flatMap((kind) =>
    directoryNames(resolve(pluginsRoot, kind)).map((plugin) => {
      const ownPath = `^plugins/${kind}/${plugin}/`;
      return {
        name: `plugin-${kind}-${plugin}-is-isolated`,
        severity: "error",
        from: { path: ownPath },
        to: { path: "^plugins/", pathNot: ownPath },
      };
    }),
  );
}

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular-dependencies",
      severity: "error",
      from: { path: firstPartyCode },
      to: { circular: true },
    },
    {
      name: "student-does-not-import-other-apps",
      severity: "error",
      from: { path: "^apps/student/" },
      to: { path: "^apps/(teacher-server|dashboard|admin-cli)/" },
    },
    {
      name: "teacher-server-does-not-import-other-apps",
      severity: "error",
      from: { path: "^apps/teacher-server/" },
      to: { path: "^apps/(student|dashboard|admin-cli)/" },
    },
    {
      name: "dashboard-imports-only-public-packages",
      severity: "error",
      from: {
        path: "^apps/dashboard/",
        pathNot: "^apps/dashboard/(?:stryker|vitest)\\.config\\.mjs$",
      },
      to: {
        path: "^(apps/(student|teacher-server|admin-cli)/|packages/(?!protocol/|shared/|i18n/|plugin-api/|plugin-runtime/src/generated/dashboard-browser-catalog\\.[tj]s$))",
      },
    },
    {
      name: "server-does-not-import-dashboard-browser",
      severity: "error",
      from: {
        path: "^(apps/teacher-server/|packages/plugin-runtime/src/(?:index|generated/plugin-catalog)\\.[tj]s$)",
      },
      to: { path: "(dashboard-browser-catalog|/browser\\.[tj]s$|(^|/)react(/|$))" },
    },
    {
      name: "pure-plugin-api-stays-pure",
      severity: "error",
      from: { path: "^packages/plugin-api/src/", pathNot: "(browser\\.[tj]s$|\\.test\\.)" },
      to: { path: "(/browser\\.[tj]s$|(^|/)react(/|$)|^node:)" },
    },
    {
      name: "protocol-is-independent",
      severity: "error",
      from: { path: "^packages/protocol/" },
      to: { path: "^(apps|plugins)/" },
    },
    {
      name: "shared-is-neutral",
      severity: "error",
      from: { path: "^packages/shared/" },
      to: { path: "^(apps|plugins|packages/(?!shared/))" },
    },
    {
      name: "plugins-use-only-public-first-party-contracts",
      severity: "error",
      from: { path: "^plugins/[^/]+/[^/]+/src/" },
      to: { path: "^(apps/|packages/(?!plugin-api/))" },
    },
    ...pluginIsolationRules(),
    {
      name: "agent-upstream-is-owned-by-its-adapter",
      severity: "error",
      from: {
        path: firstPartyCode,
        pathNot: "^packages/deepagents-adapter/",
      },
      to: {
        path: "(^|/)(deepagents|langchain|@langchain/[^/]+)(/|$)",
      },
    },
    {
      name: "bun-sqlite-is-owned-by-storage-adapter",
      severity: "error",
      from: {
        path: firstPartyCode,
        pathNot: "^packages/sqlite-storage/",
      },
      to: {
        path: "^bun:sqlite$",
      },
    },
    {
      name: "opentui-is-owned-by-student-interface",
      severity: "error",
      from: {
        path: firstPartyCode,
        pathNot: "^packages/student-tui/",
      },
      to: {
        path: "(^|/)@opentui/(core|react)(/|$)",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Exclude generated first-party output, but retain edges into npm dist exports.
    exclude: {
      path: "(^|/)(?:\\.stryker-tmp|coverage|references|reports)(/|$)|^(?!.*(?:^|/)node_modules/).*(?:^|/)dist(/|$)",
    },
    enhancedResolveOptions: {
      conditionNames: ["types", "import", "default"],
      exportsFields: ["exports"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
