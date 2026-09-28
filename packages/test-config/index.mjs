import { defineConfig } from "vitest/config";

const coverageThresholds = Object.freeze({
  branches: 100,
  functions: 100,
  lines: 100,
  perFile: true,
  statements: 100,
});

const strykerDefaults = {
  coverageAnalysis: "perTest",
  incremental: false,
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  thresholds: { break: 100, high: 100, low: 100 },
  vitest: { configFile: "vitest.config.mjs" },
};

export function createPackageVitestConfig(sourcePattern = "src/**/*.ts") {
  return defineConfig({
    test: {
      coverage: {
        clean: true,
        exclude: ["**/*.d.ts", "**/*.fixture.ts", "**/*.{spec,test}.{ts,tsx}"],
        include: [sourcePattern],
        provider: "v8",
        reporter: ["text", "json-summary", "lcov"],
        thresholds: coverageThresholds,
      },
      exclude: ["**/.stryker-tmp/**", "**/node_modules/**"],
      include: ["src/**/*.{spec,test}.{ts,tsx}"],
      passWithNoTests: false,
    },
  });
}

export function createPackageStrykerConfig(options) {
  const reporters = options.jsonReport
    ? ["clear-text", "json", "progress"]
    : ["clear-text", "progress"];
  return {
    ...strykerDefaults,
    ...(options.ignoreStatic ? { ignoreStatic: true } : {}),
    ...(options.jsonReport ? { jsonReporter: { fileName: "reports/mutation/mutation.json" } } : {}),
    mutate: [
      `src/**/*.${options.extensions}`,
      "!src/**/*.{spec,test}.{ts,tsx}",
      "!src/**/*.fixture.ts",
      ...(options.excludeTypeTests ? ["!src/**/*.test-d.ts"] : []),
    ],
    reporters,
  };
}
